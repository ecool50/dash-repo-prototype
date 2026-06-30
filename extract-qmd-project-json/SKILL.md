---
name: extract-qmd-project-json
description: Extract and summarize structured project metadata from Quarto Markdown (.qmd) analysis reports into portable project JSON and missing-field warnings. Use when Codex needs to read QMD reports, identify factual project metadata, summarize research area/disease/data modality/keywords/questions/methods/core packages, rewrite analytical questions for readability, add concise omics QC question/method summaries, or avoid over-reporting generic software packages.
---

# Extract QMD Project JSON

Create project metadata from `.qmd` reports using the source document as evidence. This skill is intentionally instruction-only and portable: do not depend on any bundled private script.

## Workflow

1. Confirm each input `.qmd` path exists.
2. Read only the useful evidence:
   - YAML front matter, especially `title`, `author`, `date`, and identifiers.
   - Narrative text: executive summary, section headings, question headings, approach/method bullets, observation/comment bullets, QC sections, and figure captions when helpful.
   - Code evidence only for package imports, programming languages, data-loading hints, normalization/filtering/QC hints, batch/run-order variables, and explicit URLs. Ignore implementation details.
3. Extract factual fields from direct evidence:
   - Project reference from forms such as `CPCDASH0052`, `DASH0052`, `CPC DASH - 0052`.
   - Title from YAML title after removing obvious reference prefixes when useful.
   - Lead data scientist from YAML `author` when the user or local convention says author represents the lead; otherwise keep unsupported people null/empty.
   - Programming languages from code block languages.
   - Explicit repository/report URLs only when written in the QMD.
4. Use semantic summarization for the fields that require interpretation:
   - `research_area`, `disease`, `data_modality`, concise `keywords`, `sample_info`, readable `analytical_questions`, `qc`, `primary_methods`, core `tools_packages`, and tags.
   - Prefer a local/lightweight LLM when available, but keep the final output grounded in QMD evidence and agent review.
5. Validate the final JSON shape against `references/project-json-schema.md`.
6. Produce a warnings JSON listing missing or uncertain fields, unsupported inferences avoided, and any semantic extraction caveats.

## Field Policy

- Unknown scalar facts must be `null`; unknown list fields must be `[]`.
- Default `status` to `"active"` unless the QMD explicitly says otherwise.
- Default `access` to internal/shared values only when the user has not provided a different access policy.
- Never invent collaborators, analyst team members, research leaders, partners, ethics status, Indigenous health relevance, GitHub repositories, sample counts, or platform providers.
- Use `provenance`, not `provinance`.
- Use `analytical_questions`, not `analytical question`.

## Package Policy

For `analytical_methods.tools_packages`, include only core scientific, statistical, domain, or workflow packages that materially indicate the analysis method.

Keep examples:
- Single-cell/spatial containers and workflows: `SingleCellExperiment`, `SpatialExperiment`, `Seurat`, `zellkonverter`, `DropletUtils`.
- Annotation/classification/scoring: `scClassify`, `VISION`, `scuttle`, `scater` when used for normalization/QC.
- Differential testing/enrichment/statistics: `edgeR`, `limma`, `fgsea`, `clusterProfiler`, `DOSE`.
- Domain-specific or project-specific packages: keep when they reveal the method.

Usually exclude generic support packages unless they are central to the report:
- Plotting/table/reporting: `ggplot2`, `ggpubr`, `ComplexHeatmap`, `patchwork`, `DT`, `knitr`, `kableExtra`, `scales`.
- General data manipulation/IO/helpers: `dplyr`, `tidyr`, `tidyverse`, `readr`, `readxl`, `purrr`, `stringr`, `forcats`, `glue`, `Matrix`, `S4Vectors`, `AnnotationDbi`.

Do not simply copy every `library(...)` line.

## Analytical Questions

Rewrite analytical questions into readable, catalog-friendly language. Preserve the scientific intent, but do not mechanically copy awkward headings.

- Generalize dataset names when they are only examples of public/reference datasets, for example rewrite "Kuppe and Reichart datasets" as "public cardiac single-cell datasets" if that is clearer.
- Keep biologically important entities, contrasts, and endpoints, for example genes, disease groups, cell types, treatment groups, and model genotypes.

## QC Section

Create a separate top-level `qc` section as a concise list of question/method pairs:

```json
"qc": [
  {
    "qc_question": "Any batch effect in the dataset?",
    "qc_method": "PCA showed no batch effect"
  },
  {
    "qc_question": "Is feature detection strongly dependent on signal intensity?",
    "qc_method": "missingness versus intensity plot"
  }
]
```

- Keep `qc` concise: usually 3-6 entries.
- Each `qc_question` should be a readable QC question, not just a category label.
- Each `qc_method` should be the method, diagnostic, or result described in the QMD, for example `PCA`, `RUV/hRUV normalisation`, `missingness plot`, `pooled QC CV`, `internal standard stability`, `run-order drift plot`, `sample correlation`, `expression > 0`, or `minimum donors per group`.
- If a useful QC question is strongly implied but the method is not reported, set `qc_method` to `null`.
- Prefer exact thresholds and methods when present. Avoid long explanations.
- For omics QC question selection, read [references/omics-qc-question-bank.md](references/omics-qc-question-bank.md) when the report includes raw FASTQ, microbiome, scRNA-seq, spatial transcriptomics, proteomics, metabolomics, lipidomics, UK Biobank, or broad omics QC.

## Semantic Review

After generation, review for these common errors:

- A gene, model name, dataset name, or package has been incorrectly listed as a disease.
- A package has been incorrectly listed as a platform provider.
- Keywords are too long; keep about 4-8 high-value terms.
- Tools contain generic plotting or data-wrangling packages.
- Analytical questions are raw headings rather than readable summaries.
- `qc` is missing, too verbose, or lacks question/method pairs.
- People, ethics, partners, repository URL, or sample count were guessed.

Read [references/project-json-schema.md](references/project-json-schema.md) when checking the exact output contract.
