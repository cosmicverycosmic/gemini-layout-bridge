#!/usr/bin/env python
import sys
import json
import os

from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

DEFAULT_MODEL = os.getenv("GLB_LLM_MODEL", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")

print(f"[llm_classifier] Loading model: {DEFAULT_MODEL}...", file=sys.stderr)
tokenizer = AutoTokenizer.from_pretrained(DEFAULT_MODEL)
model = AutoModelForCausalLM.from_pretrained(
    DEFAULT_MODEL,
    torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
    device_map="auto"
)
print("[llm_classifier] Model loaded.", file=sys.stderr)


DIVI_MODULES = [
    "fullwidth_header",
    "blurb_grid",
    "pricing_tables",
    "faq_accordion",
    "testimonials_slider",
    "contact_form",
    "code"
]

BASE_INSTRUCTIONS = """
You are a web layout classifier that maps HTML sections of a landing page into Divi Builder modules.

Available module types (you MUST choose exactly one):
- fullwidth_header
- blurb_grid
- pricing_tables
- faq_accordion
- testimonials_slider
- contact_form
- code   (generic fallback if nothing else fits)

Rules:
- If it's a hero section with main headline, subheadline, and primary CTA(s), use "fullwidth_header".
- If it lists 2-6 services/features in cards or columns, use "blurb_grid".
- If it clearly shows plans/pricing tiers, use "pricing_tables".
- If it's clearly a list of questions and answers, use "faq_accordion".
- If it's customer quotes with names/roles, use "testimonials_slider".
- If it has a contact form or call-to-contact, use "contact_form".
- Otherwise, use "code".

You must return ONLY a JSON object with this shape:
{
  "module_type": "<one of the above>",
  "params": {
    ...
  }
}

"params" keys should match the module type, e.g.:

For fullwidth_header:
- title
- subtitle
- button_primary_text
- button_primary_url
- background_color

For blurb_grid:
- items: [ { "title": "...", "body": "..." }, ... ]

For pricing_tables:
- plans: [
    {
      "name": "...",
      "tagline": "...",
      "price": "...",
      "billing_period": "...",
      "button_text": "...",
      "button_url": "...",
      "features": [ "...", "..." ]
    }, ...
  ]

For faq_accordion:
- items: [ { "question": "...", "answer": "..." }, ... ]

For testimonials_slider:
- items: [ { "author": "...", "role": "...", "quote": "..." }, ... ]

For contact_form:
- title
- subtitle

If you cannot confidently fill a field, you may omit it.
If you cannot classify the section into any of the specific types, use:
{
  "module_type": "code",
  "params": {}
}
"""


def build_prompt(section):
  text = section.get("text", "")
  snippet = section.get("htmlSnippet", "")
  sec_type = section.get("type", "generic")
  sec_id = section.get("id", "")
  sec_classes = section.get("classes", "")

  text = text[:800]
  snippet = snippet[:800]

  return (
    BASE_INSTRUCTIONS
    + "\n\n--- SECTION METADATA ---\n"
    + f"Type hint: {sec_type}\n"
    + f"ID: {sec_id}\n"
    + f"Classes: {sec_classes}\n"
    + "\n--- SECTION TEXT (approximate) ---\n"
    + text
    + "\n\n--- SECTION HTML SNIPPET ---\n"
    + snippet
    + "\n\nNow respond with ONLY the JSON object (no explanation, no backticks)."
  )


def run_model(prompt):
  inputs = tokenizer(prompt, return_tensors="pt")
  input_ids = inputs["input_ids"].to(model.device)
  attention_mask = inputs["attention_mask"].to(model.device)

  with torch.no_grad():
    outputs = model.generate(
      input_ids=input_ids,
      attention_mask=attention_mask,
      max_new_tokens=384,
      do_sample=False,
      pad_token_id=tokenizer.eos_token_id
    )

  generated = outputs[0][input_ids.shape[-1]:]
  text = tokenizer.decode(generated, skip_special_tokens=True)
  return text.strip()


def parse_json_from_output(text):
  text = text.strip()

  start = text.find("{")
  end = text.rfind("}")
  if start == -1 or end == -1 or end <= start:
    raise ValueError("No JSON object found in output")

  json_str = text[start : end + 1]
  return json.loads(json_str)


def classify_section(section):
  try:
    prompt = build_prompt(section)
    raw = run_model(prompt)
    obj = parse_json_from_output(raw)

    module_type = obj.get("module_type", "code")
    if module_type not in DIVI_MODULES:
      module_type = "code"

    params = obj.get("params", {})
    if not isinstance(params, dict):
      params = {}

    return module_type, params
  except Exception as e:
    # Fallback: simple heuristic
    txt = section.get("text", "").lower()
    if "pricing" in txt or "per month" in txt or "plan" in txt:
      return "pricing_tables", {}
    if "faq" in txt or "frequently asked questions" in txt:
      return "faq_accordion", {}
    if "contact" in txt or "get in touch" in txt:
      return "contact_form", {}
    if "testimonials" in txt or "what our clients say" in txt:
      return "testimonials_slider", {}
    return "code", {}


def main():
  raw = sys.stdin.read()
  data = json.loads(raw)

  builder = data.get("builder", "divi")
  sections = data.get("sections", [])

  results = []

  if builder != "divi":
    # Nothing to do; but keep shape
    for s in sections:
      idx = s.get("index", 0)
      results.append({
        "index": idx,
        "module_type": "code",
        "params": {}
      })
  else:
    for s in sections:
      idx = s.get("index", 0)
      module_type, params = classify_section(s)
      results.append({
        "index": idx,
        "module_type": module_type,
        "params": params
      })

  out = {"results": results}
  sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
  main()
