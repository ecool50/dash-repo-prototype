# Omics QC Question Bank

Use this reference as examples of `qc` entries. Do not include all questions. Pick only questions supported by the QMD evidence and useful for the dataset.

## General Omics QC

- Are metadata, sample labels, groups, batches, run order, and paired/repeated structures trustworthy?
- Are biological groups confounded with technical factors?
- Are any samples globally unreliable?
- Are measured features reliable enough for downstream analysis?
- Does missingness indicate sample-level or feature-level quality concerns?
- Does the intensity distribution look sensible before and after transformation/normalisation?
- Is missingness associated with abundance, group, batch, or feature class?
- Do technical controls, pooled QC samples, internal standards, blanks, or replicates behave as expected?
- Are batch, plate, operator, or run-order effects visible?
- Does normalisation reduce technical variation while preserving biological signal?
- Are exclusion rules defensible and documented?
- Does the retained dataset still represent the intended biological question?

## Proteomics

- Are data structures consistent across datasets?
- Should missing data raise quality concerns?
- Do intensity distributions look sensible?
- Do PCA or clustering diagnostics show technical structure?

## Metabolomics

- Is there global signal drift or injection-to-injection instability?
- Does feature or sample missingness require filtering?
- Is feature detection strongly dependent on signal intensity?
- Is there batch structure or run-order drift before normalisation?
- Are metabolite measurements stable across pooled QC samples?
- Are internal standards stable across the analytical run?
- Does hRUV/RUV normalisation reduce batch or run-order drift while preserving biological signal?

## Lipidomics

- Is there large-scale variation in raw total lipid signal across samples?
- Does missingness indicate samples or lipid features requiring filtering?
- Which lipid classes are retained after missingness filtering?
- Are raw lipid signals stable enough for normalisation and downstream modelling?
- Does sample-wise normalisation reduce large-scale intensity differences?
- What are the major sources of variation in the lipidomics data?
- Are PCA outliers caused by technical failure or class-specific lipid shifts?
- How reproducible are lipid measurements across pooled QC samples?
- Are some lipid classes less reproducible than others?
- Are high-intensity lipid features stable across biological samples?
- Are internal-standard-like lipid features stable across samples?

## Raw FASTQ

- Are per-base quality scores acceptable across read positions?
- Is there adapter, primer, or overrepresented sequence contamination?
- Are GC-content profiles consistent with the expected organism or assay?
- Are read lengths and read counts consistent across samples?
- Is sequence duplication unusually high?
- Is there evidence of lane, index, or sample contamination?
- Are paired-end reads synchronized and complete?
- Do MultiQC summaries show samples requiring exclusion or resequencing?
- Do majority segments aligned to the reference genome?

## Microbiome

- Are sequencing depths sufficient and comparable across samples?
- Are low-depth samples or rare features removed using defensible thresholds?
- Are alpha-diversity and beta-diversity patterns dominated by technical factors?
- Are batch, extraction kit, sequencing run, or plate effects visible?
- Are taxonomic profiles consistent with sample type and expected biology?
- Are rarefaction or compositional normalisation choices appropriate?
- Do replicate or mock-community controls behave as expected?
- Is the data analysis at absolute value or relative abundance?
- What kind of transformation used for relative abundance?


## scRNA-seq

- Are per-cell UMI counts, detected genes, and mitochondrial/ribosomal percentages acceptable?
- Were low-quality cells and lowly detected genes filtered with defensible thresholds?
- Is there evidence of doublets or multiplets?
- Is ambient RNA or background contamination likely to affect interpretation?
- Do samples or batches separate before correction?
- Does integration reduce batch effects while preserving biological structure?
- Are clusters supported by marker genes and sufficient cell numbers?
- Are UMI counts, detected genes, and mitochondrial percentage acceptable across spatial locations or samples?

## Spatial Transcriptomics

- Are tissue images, spots/cells, and expression coordinates correctly aligned?
- Are spots/cells outside tissue or low-quality tissue regions removed?
- Are UMI counts, detected genes, and mitochondrial percentage acceptable across spatial locations?
- Is segmentation quality sufficient if cell-level spatial data are used?
- Are spatial artefacts visible across slides, capture areas, or tissue edges?
- Are batch, slide, region, or run effects visible in PCA/UMAP or spatial plots?
- Does normalisation preserve spatial biological structure while reducing technical variation?
- Are cell-type annotations or deconvolution results spatially plausible?

## UK Biobank

- Are phenotype definitions, case/control labels, and covariates trustworthy?
- Are genotype sample QC filters documented?
- Are ancestry, relatedness, sex mismatch, and heterozygosity outliers handled?
- Are variant missingness, minor allele frequency, Hardy-Weinberg equilibrium, and imputation quality filters applied?
- Are batch, genotyping array, assessment centre, or recruitment effects assessed?
- Are population structure and relatedness controlled in the model?
- Is missingness in phenotypes or covariates likely to bias results?
- Are case/control numbers and statistical power adequate?

## Method Phrases

Prefer short `qc_method` phrases such as:

- `PCA by batch/group/run order`
- `missingness by sample and feature`
- `intensity distribution plots`
- `mean-variance trend`
- `feature detection versus intensity plot`
- `pooled QC CV`
- `internal standard stability plot`
- `run-order drift plot`
- `sample-to-sample correlation`
- `RUV/hRUV normalisation`
- `TMM/logCPM normalisation`
- `feature filtering threshold`
- `sensitivity analysis`
- `FastQC/MultiQC`
- `adapter contamination check`
- `per-base Phred quality`
- `read depth/library size summary`
- `negative-control contamination check`
- `rarefaction curve`
- `alpha/beta diversity by batch`
- `doublet detection`
- `ambient RNA assessment`
- `mitochondrial/ribosomal percentage`
- `integration diagnostics`
- `histology-expression alignment`
- `spot/cell segmentation QC`
- `spatial QC plots`
- `genotype missingness filters`
- `HWE/MAF/imputation INFO filters`
- `ancestry PCs`
- `relatedness and sex mismatch checks`
