// Shared omics/assay abbreviation expansion, used on BOTH sides of retrieval:
//   - queries (search.js), before embedding + reranking
//   - documents (ingest.js buildSourceText), before embedding
// Keeping one map means query and corpus vocabulary can't drift apart — an
// abbreviated query retrieves the same projects as the spelled-out form.
// bge-large does not bridge these on its own (e.g. "IMC" alone returns
// nothing; "imaging mass cytometry" scores ~0.9). Extend as the catalogue
// grows. Order matters: specific forms (scRNA-seq) precede generic RNA-seq.
export const ABBREVIATIONS = [
  [/\bscRNA[-\s]?seq\b/gi, 'single-cell RNA sequencing scRNA-seq'],
  [/\bsnRNA[-\s]?seq\b/gi, 'single-nucleus RNA sequencing snRNA-seq'],
  [/\bscATAC[-\s]?seq\b/gi, 'single-cell ATAC sequencing scATAC-seq'],
  [/\bATAC[-\s]?seq\b/gi, 'ATAC sequencing chromatin accessibility ATAC-seq'],
  [/\bRNA[-\s]?seq\b/gi, 'RNA sequencing RNA-seq'],
  [/\bIMC\b/g, 'imaging mass cytometry IMC'],
  [/\bCyTOF\b/gi, 'mass cytometry CyTOF'],
  [/\bDIA\b/g, 'data-independent acquisition proteomics DIA'],
  [/\bWGS\b/g, 'whole-genome sequencing WGS'],
  [/\bWES\b/g, 'whole-exome sequencing WES'],
  [/\bTMA\b/g, 'tissue microarray TMA'],
  [/\bIHC\b/g, 'immunohistochemistry IHC'],
];

export function expandAbbreviations(text) {
  return ABBREVIATIONS.reduce((s, [re, full]) => s.replace(re, full), text);
}
