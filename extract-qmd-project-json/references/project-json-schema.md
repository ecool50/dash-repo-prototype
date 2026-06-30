# Project JSON Schema

Use this portable schema unless the user explicitly requests a legacy schema.

```json
{
  "ref_number": null,
  "title": null,
  "status": "active",
  "investigators": {
    "collaborator": null,
    "lead_data_scientist": null,
    "analyst_team": [],
    "research_leader": null
  },
  "partners": null,
  "project_details": {
    "research_area": [],
    "disease": [],
    "data_modality": [],
    "keywords": [],
    "platform": {
      "provider": null
    },
    "sample_info": {
      "sample_type": null,
      "n_samples": null,
      "organism": null
    }
  },
  "analytical_questions": {
    "primary_question": null,
    "other_questions": []
  },
  "qc": [
    {
      "qc_question": null,
      "qc_method": null
    }
  ],
  "analytical_methods": {
    "primary_methods": [],
    "tools_packages": [],
    "programming_languages": []
  },
  "outputs": {
    "github_repo": null
  },
  "provenance": {
    "indigenous_health": null,
    "ethics_required": null
  },
  "tags": {
    "asana_tags": [],
    "method_tags": []
  },
  "access": {
    "preset": "shared",
    "discovery": "dash_internal",
    "summary": "dash_internal",
    "report_link": "dash_internal",
    "code_link": "dash_internal"
  }
}
```

Warnings JSON should be a separate object:

```json
{
  "missing_fields": [],
  "uncertain_fields": [],
  "notes": []
}
```

`missing_fields` should use dotted paths, for example `investigators.collaborator` or `project_details.sample_info.n_samples`.

The `qc` array should usually contain 3-6 concise question/method pairs. Use `qc_method: null` when the QC question is relevant but the QMD does not report a diagnostic or method.

If a legacy consumer still requires the original user-provided schema, map:

- `ref_number` to `Ref_number`
- `lead_data_scientist` to `Lead_data_scientist`
- `analyst_team` to `Analyst_team`
- `partners` to `Partners`
- `analytical_questions` to `analytical question`
- `provenance` to `provinance`

Do this mapping only when explicitly requested.
