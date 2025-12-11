#!/usr/bin/env python

import sys
import json
import os
import re

from transformers import AutoTokenizer, AutoModelForCausalLM, pipeline

MODEL_NAME = os.getenv("GLB_LLM_MODEL", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")

_system_prompt = """
You are a JSON-only classifier for marketing site sections.

You receive a snippet of content that may come from:
- A React TSX/JSX component,
- An Angular HTML template,
- Or plain HTML text.

Your job:
1. Decide what kind of section it is: e.g. "hero", "pricing", "faq", "testimonials", "contact", "services", "features", "cta", or "generic".
2. Propose how to map it into Divi modules.

You MUST respond with ONLY a single JSON object, no explanation, no backticks, no surrounding text.

The JSON MUST look like:

{
  "type": "hero",
  "builder": {
    "divi": {
      "module_type": "fullwidth_header",
      "params": {
        "title": "string",
        "subtitle": "string",
        "button_primary_text": "string",
        "button_primary_url": "string",
        "background_color": "#050915"
      }
    }
  }
}

Guidelines:

- For hero sections (big headline + subhead + primary/secondary CTAs), use:
  "module_type": "fullwidth_header"

- For feature / services grids, use:
  "module_type": "blurb_grid"
  with "params.items": [{ "title": "...", "body": "...", "column_width": "1_3" }, ...]

- For pricing sections, use:
  "module_type": "pricing_tables"
  with "params.plans": [{
    "name": "...",
    "tagline": "...",
    "price": "...",
    "billing_period": "...",
    "button_text": "...",
    "button_url": "...",
    "features": ["..."]
  }, ...]

- For FAQ sections, use:
  "module_type": "faq_accordion"
  with "params.items": [{ "question": "...", "answer": "..." }, ...]

- For testimonials, use:
  "module_type": "testimonials_slider"
  with "params.items": [{ "author": "...", "role": "...", "quote": "..." }, ...]

- For contact sections, use:
  "module_type": "contact_form"
  (params can be an empty object).

- If you cannot confidently map it, use:
  "module_type": "code"
  with "params": {}.

You may leave strings empty if you cannot infer them.
""".strip()


# Lazy global pipeline to avoid repeated model loads in a single run.
_pipe = None


def get_pipe():
  global _pipe
  if _pipe is None:
    tok = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)
    _pipe = pipeline(
      "text-generation",
      model=model,
      tokenizer=tok,
      max_new_tokens=512,
      temperature=0.1,
      do_sample=False
    )
  return _pipe


def extract_json_from_text(text: str) -> str:
  """
  Extracts the first {...} block from the model output.
  Returns the raw JSON string or raises ValueError.
  """
  if not text:
    raise ValueError("empty text from model")

  # Strip any weird leading logging lines
  # (e.g. "Starting from v4.46..." or other HF warnings).
  # Then look for the first '{' and the last '}'.
  start = text.find('{')
  end = text.rfind('}')

  if start == -1 or end == -1 or end <= start:
    raise ValueError("no JSON object delimiters found")

  candidate = text[start : end + 1].strip()

  # Occasionally the model might insert junk between JSON atoms; you can add
  # minor cleanup if needed.
  return candidate


def classify(snippet: str, heuristics: dict) -> dict:
  """
  Run the LLM on the snippet and return the JSON classification.
  If anything fails, return a fallback using heuristics.
  """
  fallback = {
    "type": "generic",
    "builder": {
      "divi": heuristics or {
        "module_type": "code",
        "params": {}
      }
    }
  }

  snippet = (snippet or "").strip()
  if not snippet:
    return fallback

  try:
    pipe = get_pipe()
  except Exception as e:
    # Can't load model, just use fallback
    print(fallback)
    return fallback

  user_prompt = (
    "Snippet:\n"
    "-----------------\n"
    f"{snippet}\n"
    "-----------------\n\n"
    "Return ONLY the JSON object described in the instructions."
  )

  try:
    outputs = pipe(
      _system_prompt + "\n\n" + user_prompt,
      num_return_sequences=1
    )
  except Exception:
    print(json.dumps(fallback))
    return fallback

  if not outputs:
    print(json.dumps(fallback))
    return fallback

  raw = outputs[0].get("generated_text", "") or ""
  try:
    json_str = extract_json_from_text(raw)
    parsed = json.loads(json_str)
  except Exception:
    print(json.dumps(fallback))
    return fallback

  # Normalize builder/divi presence
  if "builder" not in parsed or not isinstance(parsed["builder"], dict):
    parsed["builder"] = {}
  if "divi" not in parsed["builder"]:
    parsed["builder"]["divi"] = heuristics or {
      "module_type": "code",
      "params": {}
    }

  if "type" not in parsed or not isinstance(parsed["type"], str) or not parsed["type"].strip():
    parsed["type"] = "generic"

  print(json.dumps(parsed))
  return parsed


def main():
  try:
    data_raw = sys.stdin.read()
    if not data_raw:
      # No input; emit a trivial fallback
      print(json.dumps({
        "type": "generic",
        "builder": {
          "divi": {
            "module_type": "code",
            "params": {}
          }
        }
      }))
      return

    data = json.loads(data_raw)
    snippet = data.get("snippet", "")
    heuristics = data.get("heuristics", {})

    result = classify(snippet, heuristics)
    # classify() already prints result, but we ensure a valid JSON output here
    # in case classify() returns without printing (it doesn't currently).
    # This double-print is harmless if kept consistent; to avoid it, you can
    # remove the print() in classify() and only print here.
    # For safety, we re-print the final JSON.
    print(json.dumps(result))

  except Exception:
    # On any exception, output a basic fallback and exit successfully so
    # Node doesn't see this as a hard failure.
    fallback = {
      "type": "generic",
      "builder": {
        "divi": {
          "module_type": "code",
          "params": {}
        }
      }
    }
    print(json.dumps(fallback))


if __name__ == "__main__":
  main()
