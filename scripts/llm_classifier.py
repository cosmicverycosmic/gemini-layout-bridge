#!/usr/bin/env python

import json
import os
import sys
from typing import Any, Dict

from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

MODEL_CACHE: Dict[str, Any] = {}


def load_model():
  """Load (or reuse) the HF model + tokenizer."""
  global MODEL_CACHE
  if MODEL_CACHE:
    return MODEL_CACHE["tok"], MODEL_CACHE["model"]

  model_name = os.getenv("GLB_LLM_MODEL", "microsoft/Phi-3-mini-4k-instruct")
  print(f'[llm_classifier] Using model: {model_name}', file=sys.stderr)

  tok = AutoTokenizer.from_pretrained(model_name)
  model = AutoModelForCausalLM.from_pretrained(
      model_name,
      torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
      device_map="auto"
  )

  MODEL_CACHE["tok"] = tok
  MODEL_CACHE["model"] = model
  return tok, model


def build_prompt(html: str, context: Dict[str, Any]) -> str:
  """
  Build a strict prompt so the model:
    - Chooses a semantic type (hero, feature_grid, pricing, testimonials, contact, footer, generic)
    - Picks an appropriate Divi module
    - Optionally returns normalized_html (static HTML, no JSX / loops)
  """
  framework = context.get("framework", "")
  page_title = context.get("pageTitle", "")
  section_index = context.get("sectionIndex", -1)

  # IMPORTANT: no instructions to invent forms unless there clearly is one.
  system_instructions = f"""
You are a layout classifier that maps HTML/TSX sections into Divi Builder modules.

You MUST respond with **only** a single JSON object, no markdown, no prose.

Valid "type" values include:
  - "hero" (big intro, main heading)
  - "feature_grid" (benefits, features, how-it-works steps, icons)
  - "pricing" (plans, prices, lifetime, $ amounts)
  - "testimonials"
  - "contact" (only when there is a real contact form or very clear contact markup)
  - "footer"
  - "generic" (fallback)

You know these Divi modules (examples, not exhaustive):
  - "text"              (generic text / headings)
  - "blurb"             (icon + title + text)
  - "blurb_grid"        (multiple blurbs / features)
  - "slider"            (generic slider)
  - "testimonials_slider"
  - "pricing_table"
  - "contact_form"
  - "button"
  - "feature_grid"      (custom logical grouping of blurbs/features)
  - "hero"              (hero layout: headline, subheadline, buttons)
  - "footer"
  - "code"              (raw HTML/JS)

RULES:

1. Do NOT choose "contact" or "contact_form" unless the snippet clearly contains a real form:
   - <form>, <input>, <textarea>, <select>, or obvious contact text like "Contact Us", "Send Message", "Email".
   If those are missing, treat it as a feature or generic section instead.

2. For pricing sections (type "pricing", module_type "pricing_table"):
   - There should be words like "Pricing", "Plan", "$39", "Lifetime", "Buy now", etc.

3. For hero sections:
   - Look for a primary heading (H1 or similar), tagline, and one or more call-to-action buttons.

4. Fill "builder.divi.params" with **useful content** extracted from the HTML,
   such as headings, subheadings, bullet labels, CTA labels, etc.
   This should be simple strings/arrays, not nested HTML.

5. Include an optional "normalized_html" string:
   - Best-effort STATIC HTML representing the content (no JSX/React, no {{ }}, no .map loops).
   - If you cannot improve on the original, you may repeat the input HTML.

Return JSON with this shape:

{{
  "type": "<one_of_the_types_above>",
  "builder": {{
    "divi": {{
      "module_type": "<one_of_the_modules_above_or_reasonable_guess>",
      "params": {{
        "...": "..."
      }}
    }}
  }},
  "normalized_html": "<static HTML representation of the section>"
}}

If you are unsure, choose "generic" and "code" but still try to provide normalized_html.
"""

  user_content = f"""
Framework: {framework}
Page Title: {page_title}
Section Index: {section_index}

--- SECTION SNIPPET START ---
{html}
--- SECTION SNIPPET END ---
"""

  # For Phi-3 instruct we can just concatenate; HF will apply a default chat template.
  prompt = system_instructions.strip() + "\n\nUser:\n" + user_content.strip()
  return prompt


def generate_json(prompt: str) -> Dict[str, Any]:
  tok, model = load_model()

  inputs = tok(
      prompt,
      return_tensors="pt",
      truncation=True,
      max_length=4096,
  )
  inputs = {k: v.to(model.device) for k, v in inputs.items()}

  with torch.no_grad():
    out = model.generate(
        **inputs,
        max_new_tokens=512,
        do_sample=True,
        temperature=0.1,
        top_p=0.9,
    )

  full_text = tok.decode(out[0], skip_special_tokens=True)

  # Try to extract the first JSON object in the output.
  first_brace = full_text.find("{")
  last_brace = full_text.rfind("}")
  if first_brace == -1 or last_brace == -1 or last_brace <= first_brace:
    raise ValueError("No JSON braces in model output")

  json_str = full_text[first_brace:last_brace + 1]

  try:
    data = json.loads(json_str)
  except Exception as e:
    raise ValueError(f"JSON parse failure: {e}")

  return data


def main():
  raw = sys.stdin.read()
  try:
    payload = json.loads(raw)
  except Exception as e:
    print(f"[llm_classifier] Failed to parse stdin JSON: {e}", file=sys.stderr)
    sys.exit(1)

  html = payload.get("html", "")
  context = payload.get("context", {}) or {}

  prompt = build_prompt(html, context)

  try:
    result = generate_json(prompt)
  except Exception as e:
    # One retry with a more explicit error message if first attempt failed
    print(f"[llm_classifier] First attempt failed: {e}", file=sys.stderr)
    retry_prompt = prompt + "\n\nIMPORTANT: Your previous response could not be parsed as JSON. " \
                             "Now respond with ONLY a single valid JSON object, no explanation."
    try:
      result = generate_json(retry_prompt)
    except Exception as e2:
      print(f"[llm_classifier] Second attempt failed: {e2}", file=sys.stderr)
      sys.exit(1)

  # Minimal sanity defaults
  if not isinstance(result, dict):
    print("[llm_classifier] Model did not return an object", file=sys.stderr)
    sys.exit(1)

  result.setdefault("type", "generic")
  result.setdefault("builder", {})
  result["builder"].setdefault("divi", {})
  result["builder"]["divi"].setdefault("module_type", "code")
  result["builder"]["divi"].setdefault("params", {})

  # normalized_html is optional; if missing, we just won't use it.
  if "normalized_html" not in result:
    result["normalized_html"] = html

  sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
  main()
