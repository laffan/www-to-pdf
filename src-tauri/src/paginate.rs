// Pagination: slice captured page content into US-Letter pages (pure Rust,
// lopdf, platform-independent — unit-tested below).
//
// WHY SEGMENTS: the capture side would love to hand over ONE tall PDF of the
// whole document, but Core Graphics clamps PDF page dimensions to 14,400 pt
// (the PDF 200-inch limit) — about 19,200 CSS px, or ~22 US-Letter pages of
// content. Anything taller silently loses its tail: the "long article is
// missing its last few pages" bug. So the renderer captures the document as
// several tall SEGMENTS, each comfortably under every known cap and cut
// exactly on an output-page boundary (so no text line straddles a segment
// edge), and pagination draws each output page from the one segment that
// contains it.
//
// Geometry per page: the segment (width w_pt) is drawn on the output page as
// a Form XObject scaled by s = content_width / w_pt, offset so the page
// band's top lands at the top of the content box, clipped to the band. Page
// boundaries snap to the nearest measured text-line/block bottom at or above
// the ideal cut so text lines are never split across pages.

// Only the Apple render pipeline calls in here, but the module is compiled
// (and its tests run) on every platform — don't let non-Apple builds flag it
// all as dead.
#![allow(dead_code)]

use lopdf::{dictionary, Document, Object, Stream};

/// Page margins in inches (US Letter output).
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// Measurements reported by the injected capture-prep script.
#[derive(serde::Deserialize)]
pub struct Meas {
    /// full document height, CSS px
    pub h: f64,
    /// actual layout width, CSS px (sanity signal: should equal the target)
    pub w: f64,
    /// bottom edges of block elements, CSS px from document top — safe breaks
    pub b: Vec<f64>,
}

/// One captured slice of the document: a single-page PDF whose content starts
/// at `top` CSS px from the document top (its extent comes from its MediaBox).
pub struct Segment {
    pub path: String,
    /// CSS px from the document top
    pub top: f64,
}

/// US Letter, points.
const PAGE_W: f64 = 612.0;
const PAGE_H: f64 = 792.0;

/// Output-page top positions in CSS px from the document top, snapped to the
/// measured safe breaks (same 40%-of-a-page snap rule as always).
pub fn compute_page_tops_px(meas: &Meas, m: &Margins) -> Vec<f64> {
    let cw = (PAGE_W - (m.left + m.right) * 72.0).max(36.0);
    let ch = (PAGE_H - (m.top + m.bottom) * 72.0).max(36.0);
    // meas.w px of content width fill cw points, so one output page holds:
    let band_px = ch * meas.w.max(1.0) / cw;
    let content_h = meas.h.max(1.0);
    let mut tops = vec![0.0_f64];
    let mut t = 0.0_f64;
    while t + band_px < content_h - 1.0 && tops.len() < 500 {
        let ideal = t + band_px;
        // Largest break at/above the cut, but keep at least 40% of a page.
        let snapped = meas
            .b
            .iter()
            .copied()
            .filter(|y| *y <= ideal - 2.0 && *y > t + band_px * 0.4)
            .fold(f64::NAN, f64::max);
        let next = if snapped.is_nan() { ideal } else { snapped };
        tops.push(next);
        t = next;
    }
    tops
}

/// Group consecutive page bands into capture segments no taller than
/// `max_px`, each cut exactly on a page top. A single band taller than
/// `max_px` (one enormous image) stays whole — it can't be split safely.
pub fn plan_segments(tops: &[f64], content_h: f64, max_px: f64) -> Vec<(f64, f64)> {
    let mut segs: Vec<(f64, f64)> = Vec::new();
    let mut start = 0.0_f64;
    for (k, &top) in tops.iter().enumerate() {
        let band_end = tops.get(k + 1).copied().unwrap_or(content_h);
        if band_end - start > max_px && top > start {
            segs.push((start, top));
            start = top;
        }
    }
    if content_h > start {
        segs.push((start, content_h));
    }
    if segs.is_empty() {
        segs.push((0.0, content_h.max(1.0)));
    }
    segs
}

/// A segment's page wrapped as a Form XObject in the output document.
struct SegForm {
    id: lopdf::ObjectId,
    /// segment page size, points
    w_pt: f64,
    h_pt: f64,
    /// document-space band this segment covers, CSS px
    top_px: f64,
}

/// Read a page's MediaBox as (w, h).
fn media_box(doc: &Document, page_id: lopdf::ObjectId) -> Result<(f64, f64), String> {
    let dict = doc.get_dictionary(page_id).map_err(|e| e.to_string())?;
    match dict.get(b"MediaBox").and_then(|o| o.as_array()) {
        Ok(mb) if mb.len() == 4 => {
            let f = |o: &Object| o.as_float().unwrap_or(0.0) as f64;
            Ok((f(&mb[2]) - f(&mb[0]), f(&mb[3]) - f(&mb[1])))
        }
        _ => Err("paginate: page has no MediaBox".into()),
    }
}

/// Wrap `page_id`'s content + resources (already living in `doc`) in a Form
/// XObject and return its id.
fn wrap_page_as_form(doc: &mut Document, page_id: lopdf::ObjectId) -> Result<SegForm, String> {
    let (w_pt, h_pt) = media_box(doc, page_id)?;
    if w_pt < 1.0 || h_pt < 1.0 {
        return Err("paginate: degenerate segment page".into());
    }
    let content = doc
        .get_page_content(page_id)
        .map_err(|e| format!("paginate: content: {e}"))?;
    let resources_obj = doc
        .get_dictionary(page_id)
        .map_err(|e| e.to_string())?
        .get(b"Resources")
        .cloned()
        .unwrap_or(Object::Dictionary(lopdf::Dictionary::new()));
    let id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), w_pt.into(), h_pt.into()],
            "Resources" => resources_obj,
        },
        content,
    ));
    Ok(SegForm { id, w_pt, h_pt, top_px: 0.0 })
}

/// Merge the (renumbered) first page of `donor` into `base` and wrap it as a
/// Form XObject. The classic lopdf merge dance: renumber the donor's objects
/// past base.max_id, move them across, then reference them.
fn absorb_segment(base: &mut Document, path: &str) -> Result<SegForm, String> {
    let mut donor = Document::load(path).map_err(|e| format!("paginate: load segment: {e}"))?;
    donor.renumber_objects_with(base.max_id + 1);
    let donor_pages = donor.get_pages();
    let &dpage = donor_pages
        .values()
        .next()
        .ok_or("paginate: segment has no pages")?;
    // Content bytes are id-free, so reading them from the donor is safe; the
    // Resources dict (taken AFTER renumbering) references donor objects that
    // are about to move into `base` under their renumbered ids.
    let (w_pt, h_pt) = media_box(&donor, dpage)?;
    if w_pt < 1.0 || h_pt < 1.0 {
        return Err("paginate: degenerate segment page".into());
    }
    let content = donor
        .get_page_content(dpage)
        .map_err(|e| format!("paginate: segment content: {e}"))?;
    let resources_obj = donor
        .get_dictionary(dpage)
        .map_err(|e| e.to_string())?
        .get(b"Resources")
        .cloned()
        .unwrap_or(Object::Dictionary(lopdf::Dictionary::new()));
    base.objects.extend(donor.objects);
    base.max_id = base.objects.keys().map(|id| id.0).max().unwrap_or(base.max_id);
    let id = base.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), w_pt.into(), h_pt.into()],
            "Resources" => resources_obj,
        },
        content,
    ));
    Ok(SegForm { id, w_pt, h_pt, top_px: 0.0 })
}

/// Assemble the final US-Letter document from the captured segments.
/// `tops` must be the output of `compute_page_tops_px` for the same `meas`.
pub fn paginate_segments(
    segs: &[Segment],
    dst: &str,
    m: &Margins,
    meas: &Meas,
    tops: &[f64],
) -> Result<(), String> {
    if segs.is_empty() || tops.is_empty() {
        return Err("paginate: nothing to paginate".into());
    }

    // The first segment's document becomes the output document (its fonts,
    // images and page tree are already in place, exactly like the old
    // single-capture path).
    let mut doc =
        Document::load(&segs[0].path).map_err(|e| format!("paginate: load: {e}"))?;
    let pages = doc.get_pages();
    let &first_page = pages.values().next().ok_or("paginate: source has no pages")?;
    let parent_id = doc
        .get_dictionary(first_page)
        .map_err(|e| e.to_string())?
        .get(b"Parent")
        .and_then(|o| o.as_reference())
        .map_err(|_| "paginate: source page has no Parent".to_string())?;

    let mut forms: Vec<SegForm> = Vec::with_capacity(segs.len());
    let mut first = wrap_page_as_form(&mut doc, first_page)?;
    first.top_px = segs[0].top;
    forms.push(first);
    for seg in &segs[1..] {
        let mut f = absorb_segment(&mut doc, &seg.path)?;
        f.top_px = seg.top;
        forms.push(f);
    }

    // Output geometry (US Letter, points).
    let (lm, rm) = (m.left * 72.0, m.right * 72.0);
    let (tm, bm) = (m.top * 72.0, m.bottom * 72.0);
    let cw = (PAGE_W - lm - rm).max(36.0);
    let ch = (PAGE_H - tm - bm).max(36.0);
    let content_h = meas.h.max(1.0);
    let band_px = ch * meas.w.max(1.0) / cw;

    let mut kids: Vec<Object> = Vec::with_capacity(tops.len());
    for (k, &t_k) in tops.iter().enumerate() {
        // This page's band ends at the NEXT page's (snapped) top — and the
        // clip must end there too, or the strip between the snapped break and
        // the full content box shows on BOTH pages.
        let band_end = tops
            .get(k + 1)
            .copied()
            .unwrap_or_else(|| content_h.min(t_k + band_px));
        // The segment holding this band (bands never straddle segments —
        // plan_segments cuts on page tops).
        let si = (0..segs.len())
            .rev()
            .find(|&i| segs[i].top <= t_k + 0.5)
            .unwrap_or(0);
        let f = &forms[si];
        // CSS px -> this segment's points (guards against DPR scaling).
        let ratio = f.w_pt / meas.w.max(1.0);
        let s = cw / f.w_pt;
        let local_top_pt = (t_k - f.top_px) * ratio;
        let local_end_pt = ((band_end - f.top_px) * ratio).min(f.h_pt);
        let clip_h = (s * (local_end_pt - local_top_pt)).clamp(1.0, ch);
        let clip_y0 = (PAGE_H - tm) - clip_h;
        // Map the band top (segment-local) to the top of the content box.
        let ty = (PAGE_H - tm) - s * (f.h_pt - local_top_pt);
        let ops = format!(
            "q {lm:.2} {clip_y0:.2} {cw:.2} {clip_h:.2} re W n {s:.6} 0 0 {s:.6} {lm:.2} {ty:.2} cm /Fm0 Do Q"
        );
        let cs = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));
        let form_ref = f.id;
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(parent_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Fm0" => Object::Reference(form_ref) },
            },
            "Contents" => Object::Reference(cs),
        });
        kids.push(Object::Reference(page));
    }

    // Swap the page tree over to the new pages.
    let n = kids.len();
    let pages_dict = doc.get_dictionary_mut(parent_id).map_err(|e| e.to_string())?;
    pages_dict.set("Kids", Object::Array(kids));
    pages_dict.set("Count", Object::Integer(n as i64));
    pages_dict.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);

    doc.save(dst).map_err(|e| format!("paginate: save: {e}"))?;
    Ok(())
}

/// Parse a printer-style page range spec ("1-3, 5, 8-10") into a sorted, deduped
/// list of 1-based page numbers within `[1, total]`. Returns `None` when the
/// spec is blank or resolves to nothing valid — the caller reads that as "keep
/// every page". Open-ended ranges are allowed: "3-" runs to the end, "-3" from
/// the start; a reversed range ("5-2") is treated as "2-5".
pub fn parse_page_ranges(spec: &str, total: usize) -> Option<Vec<usize>> {
    let spec = spec.trim();
    if spec.is_empty() || total == 0 {
        return None;
    }
    let mut keep: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(dash) = part.find('-') {
            let lo = part[..dash].trim().parse::<usize>().ok();
            let hi = part[dash + 1..].trim().parse::<usize>().ok();
            let (lo, hi) = match (lo, hi) {
                (Some(a), Some(b)) => (a.min(b), a.max(b)),
                (Some(a), None) => (a, total), // "3-" -> to the end
                (None, Some(b)) => (1, b),     // "-3" -> from the start
                (None, None) => continue,
            };
            for p in lo.max(1)..=hi.min(total) {
                keep.insert(p);
            }
        } else if let Ok(p) = part.parse::<usize>() {
            if (1..=total).contains(&p) {
                keep.insert(p);
            }
        }
    }
    if keep.is_empty() {
        None
    } else {
        Some(keep.into_iter().collect())
    }
}

/// Keep only the pages named by `spec` (printer-style range) in the PDF at
/// `path`, rewriting it in place and renumbering the survivors 1..N. A blank
/// spec, or one that keeps every page, is a no-op. The paginated document has a
/// single flat Pages node (see `paginate_segments`), so trimming is just a
/// rebuild of that node's `Kids`; the dropped page objects become unreferenced
/// (harmless in the output).
pub fn trim_to_range(path: &str, spec: &str) -> Result<(), String> {
    if spec.trim().is_empty() {
        return Ok(());
    }
    let mut doc = Document::load(path).map_err(|e| format!("trim: load: {e}"))?;
    let ordered: Vec<lopdf::ObjectId> = doc.get_pages().into_values().collect();
    let total = ordered.len();
    let Some(keep) = parse_page_ranges(spec, total) else {
        return Ok(()); // nothing valid to trim to -> keep all
    };
    if keep.len() >= total {
        return Ok(()); // range covers the whole document
    }
    let kept: Vec<Object> = keep
        .iter()
        .filter_map(|&p| ordered.get(p - 1).copied())
        .map(Object::Reference)
        .collect();
    if kept.is_empty() {
        return Ok(()); // never emit a zero-page PDF
    }
    // All paginated pages share one Parent; read it off the first survivor.
    let parent_id = doc
        .get_dictionary(ordered[keep[0] - 1])
        .map_err(|e| e.to_string())?
        .get(b"Parent")
        .and_then(|o| o.as_reference())
        .map_err(|_| "trim: page has no Parent".to_string())?;
    let n = kept.len();
    let pages_dict = doc.get_dictionary_mut(parent_id).map_err(|e| e.to_string())?;
    pages_dict.set("Kids", Object::Array(kept));
    pages_dict.set("Count", Object::Integer(n as i64));
    doc.save(path).map_err(|e| format!("trim: save: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-page PDF of the given size with a marker text, standing in for a
    /// createPDF capture segment.
    fn make_segment_pdf(path: &std::path::Path, w_pt: f64, h_pt: f64, tag: &str) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            format!("BT /F1 24 Tf 10 {:.0} Td ({tag}) Tj ET", h_pt - 30.0).into_bytes(),
        ));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(), 0.into(), w_pt.into(), h_pt.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference(font_id) },
            },
            "Contents" => Object::Reference(content_id),
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    fn margins_1in() -> Margins {
        Margins { top: 1.0, right: 1.0, bottom: 1.0, left: 1.0 }
    }

    // 1in margins on 624px-wide content: one page band = 648pt * 624/468 = 864px.
    const BAND: f64 = 864.0;

    #[test]
    fn tops_fill_pages_without_breaks() {
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![] };
        let tops = compute_page_tops_px(&meas, &margins_1in());
        assert_eq!(tops, vec![0.0, BAND, 2.0 * BAND, 3.0 * BAND]);
    }

    #[test]
    fn tops_snap_to_breaks() {
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![850.0, 1700.0] };
        let tops = compute_page_tops_px(&meas, &margins_1in());
        // First cut snaps 864 -> 850; second ideal is 850+864=1714 -> 1700.
        assert_eq!(tops[1], 850.0);
        assert_eq!(tops[2], 1700.0);
    }

    #[test]
    fn segments_cut_on_page_tops_and_stay_under_cap() {
        let meas = Meas { h: 20000.0, w: 624.0, b: vec![] };
        let tops = compute_page_tops_px(&meas, &margins_1in());
        let segs = plan_segments(&tops, meas.h, 7800.0);
        assert!(segs.len() > 1, "20000px must need multiple segments");
        // Contiguous cover of [0, content_h].
        assert_eq!(segs[0].0, 0.0);
        assert_eq!(segs.last().unwrap().1, 20000.0);
        for w in segs.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        for &(a, b) in &segs {
            assert!(b - a <= 7800.0 + 0.001, "segment {a}..{b} over cap");
            // Every boundary (except the doc end) is a page top.
            if b < 20000.0 {
                assert!(tops.iter().any(|t| (t - b).abs() < 0.001));
            }
        }
    }

    #[test]
    fn short_document_is_one_segment() {
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![] };
        let tops = compute_page_tops_px(&meas, &margins_1in());
        let segs = plan_segments(&tops, meas.h, 7800.0);
        assert_eq!(segs, vec![(0.0, 3000.0)]);
    }

    #[test]
    fn paginates_single_segment() {
        let dir = std::env::temp_dir().join("wwwtopdf-paginate-test-single");
        std::fs::create_dir_all(&dir).unwrap();
        let seg = dir.join("seg0.pdf");
        // 3000px at 0.75 pt/px -> 468 x 2250 pt.
        make_segment_pdf(&seg, 468.0, 2250.0, "single");
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![] };
        let m = margins_1in();
        let tops = compute_page_tops_px(&meas, &m);
        let out = dir.join("out.pdf");
        paginate_segments(
            &[Segment { path: seg.to_string_lossy().into_owned(), top: 0.0 }],
            &out.to_string_lossy(),
            &m,
            &meas,
            &tops,
        )
        .unwrap();
        let doc = Document::load(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 4);
        // Page 2 (k=1): s = 468/468 = 1, band top 864px -> 648pt local,
        // ty = (792-72) - (2250 - 648) = -882.
        let ids: Vec<_> = doc.get_pages().into_values().collect();
        let ops = String::from_utf8(doc.get_page_content(ids[1]).unwrap()).unwrap();
        assert!(ops.contains("/Fm0 Do"), "page draws the form: {ops}");
        assert!(ops.contains("72.00 -882.00 cm"), "page 2 offset: {ops}");
    }

    #[test]
    fn paginates_across_segments() {
        let dir = std::env::temp_dir().join("wwwtopdf-paginate-test-multi");
        std::fs::create_dir_all(&dir).unwrap();
        // Document: 3000px, segments cut at the page top 1728px.
        // seg0 = [0, 1728) px -> 468 x 1296 pt; seg1 = [1728, 3000) -> 468 x 954 pt.
        let seg0 = dir.join("seg0.pdf");
        let seg1 = dir.join("seg1.pdf");
        make_segment_pdf(&seg0, 468.0, 1296.0, "first");
        make_segment_pdf(&seg1, 468.0, 954.0, "second");
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![] };
        let m = margins_1in();
        let tops = compute_page_tops_px(&meas, &m);
        assert_eq!(tops, vec![0.0, 864.0, 1728.0, 2592.0]);
        let out = dir.join("out.pdf");
        paginate_segments(
            &[
                Segment { path: seg0.to_string_lossy().into_owned(), top: 0.0 },
                Segment { path: seg1.to_string_lossy().into_owned(), top: 1728.0 },
            ],
            &out.to_string_lossy(),
            &m,
            &meas,
            &tops,
        )
        .unwrap();
        let doc = Document::load(&out).unwrap();
        let ids: Vec<_> = doc.get_pages().into_values().collect();
        assert_eq!(ids.len(), 4);

        // Every page draws a form; pages 1-2 share seg0's form, pages 3-4 use
        // seg1's (a different XObject reference).
        let form_of = |page_id| {
            let res = doc.get_dictionary(page_id).unwrap().get(b"Resources").unwrap();
            let xo = res.as_dict().unwrap().get(b"XObject").unwrap();
            xo.as_dict().unwrap().get(b"Fm0").unwrap().as_reference().unwrap()
        };
        assert_eq!(form_of(ids[0]), form_of(ids[1]));
        assert_eq!(form_of(ids[2]), form_of(ids[3]));
        assert_ne!(form_of(ids[0]), form_of(ids[2]));

        // Page 3 (k=2) starts exactly at seg1's top: local_top = 0,
        // ty = (792-72) - (954 - 0) = -234.
        let ops3 = String::from_utf8(doc.get_page_content(ids[2]).unwrap()).unwrap();
        assert!(ops3.contains("72.00 -234.00 cm"), "page 3 offset: {ops3}");

        // The merged document still carries both markers' fonts/content —
        // sanity: output must load cleanly and reference only objects that
        // exist (Document::load + get_page_content already prove decoding).
        let ops4 = String::from_utf8(doc.get_page_content(ids[3]).unwrap()).unwrap();
        assert!(ops4.contains("/Fm0 Do"));
    }

    #[test]
    fn parse_ranges_covers_the_common_cases() {
        assert_eq!(parse_page_ranges("1-3,5", 10), Some(vec![1, 2, 3, 5]));
        assert_eq!(parse_page_ranges("3", 10), Some(vec![3]));
        // Whitespace, duplicates and out-of-order parts all normalize.
        assert_eq!(parse_page_ranges(" 2 - 4 , 4 , 1 ", 10), Some(vec![1, 2, 3, 4]));
        assert_eq!(parse_page_ranges("5-2", 10), Some(vec![2, 3, 4, 5])); // reversed
        assert_eq!(parse_page_ranges("8-20", 10), Some(vec![8, 9, 10])); // clamp high
        assert_eq!(parse_page_ranges("3-", 5), Some(vec![3, 4, 5])); // open end
        assert_eq!(parse_page_ranges("-3", 5), Some(vec![1, 2, 3])); // open start
        // Blank or all-invalid input means "keep everything".
        assert_eq!(parse_page_ranges("", 5), None);
        assert_eq!(parse_page_ranges("   ", 5), None);
        assert_eq!(parse_page_ranges("99", 5), None);
        assert_eq!(parse_page_ranges("0", 5), None);
        assert_eq!(parse_page_ranges("1-3", 0), None); // no pages to keep
    }

    #[test]
    fn trim_keeps_only_selected_pages() {
        let dir = std::env::temp_dir().join("wwwtopdf-trim-test");
        std::fs::create_dir_all(&dir).unwrap();
        let seg = dir.join("seg0.pdf");
        // 3000px at 0.75 pt/px -> 468 x 2250 pt, which paginates to 4 pages.
        make_segment_pdf(&seg, 468.0, 2250.0, "trim");
        let meas = Meas { h: 3000.0, w: 624.0, b: vec![] };
        let m = margins_1in();
        let tops = compute_page_tops_px(&meas, &m);
        let out = dir.join("out.pdf");
        let out_str = out.to_string_lossy().into_owned();
        paginate_segments(
            &[Segment { path: seg.to_string_lossy().into_owned(), top: 0.0 }],
            &out_str,
            &m,
            &meas,
            &tops,
        )
        .unwrap();
        assert_eq!(Document::load(&out).unwrap().get_pages().len(), 4);

        // Keep 1, 2 and 4 -> a 3-page document.
        trim_to_range(&out_str, "1-2, 4").unwrap();
        assert_eq!(Document::load(&out).unwrap().get_pages().len(), 3);

        // A blank spec or a full-cover range leaves the (now 3-page) doc alone.
        trim_to_range(&out_str, "").unwrap();
        assert_eq!(Document::load(&out).unwrap().get_pages().len(), 3);
        trim_to_range(&out_str, "1-3").unwrap();
        assert_eq!(Document::load(&out).unwrap().get_pages().len(), 3);
    }
}
