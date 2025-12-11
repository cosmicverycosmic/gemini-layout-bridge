#!/usr/bin/env python
import os
import sys
import json
from typing import Any, Dict

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM


ALLOWED_TYPES = [
    "hero",
    "pricing",
    "faq",
    "testimonials",
    "contact",
    "features",
    "gallery",
    "generic",
]

ALLOWED_DIVI_MODULES = [
    "fullwidth_header",   # hero headers
    "blurb_grid",         # feature/service cards
    "pricing_tables",     # pricing tables
    "faq_accordion",      # FAQ accordions/toggles
    "testimonials",       # testimonial cards
    "contact_form",       # contact forms
    "code",               # raw HTML fall-back
]


def load_model():
    model_name = os.getenv("GLB_LLM_MODEL", "microsoft/Phi-3-mini-4k-instruct")
    print(f"[llm_classifier] Using model: {model_name}", file=sys.stderr)

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float32,
        device_map="cpu",
    )
    return tokenizer, model


def apply_chat_template(tokenizer, system_prompt: str, user_prompt: str) -> str:
    """
    Use a chat template if the tokenizer has one; otherwise, just concatenate.
    """
    if hasattr(tokenizer, "apply_chat_template"):
        text = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            tokenize=False,
        )
        return text
    else:
        return system_prompt + "\n\nUser:\n" + user_prompt + "\n\nAssistant:"


def run_model(tokenizer, model, prompt: str, max_new_tokens: int = 512) -> str:
    inputs = tokenizer(prompt, return_tensors="pt")
    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            eos_token_id=tokenizer.eos_token_id,
        )
    text = tokenizer.decode(output_ids[0], skip_special_tokens=True)
    return text


def extract_json(text: str) -> str:
    """
    Extract the first JSON object from the model output.
    We look for the first '{' and the last '}' and slice.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model output")
    return text[start : end + 1]


def needs_fix(data: Any) -> bool:
    if not isinstance(data, dict):
        return True
    if "type" not in data or "builder" not in data:
        return True

    if data.get("type") not in ALLOWED_TYPES:
        return True

    builder = data.get("builder", {})
    if not isinstance(builder, dict):
        return True

    divi = builder.get("divi")
    if not isinstance(divi, dict):
        return True

    module_type = divi.get("module_type")
    if module_type not in ALLOWED_DIVI_MODULES:
        return True

    params = divi.get("params", {})
    if not isinstance(params, dict):
        return True

    # Everything necessary is there
    return False


def build_prompt_html(html: str, context: str) -> str:
    context_str = context.strip()
    header = ""
    if context_str:
        header = f"Context: {context_str}\n\n"

    # Keep the schema description tight – we only want one JSON object.
    user_prompt = f"""{header}You are classifying a single page section from a marketing website and deciding which Divi Builder module best fits.

Section HTML (truncated if long):
\"\"\"HTML
{html[:4000]}
\"\"\"HTML

Return a SINGLE JSON object only, with this exact schema:

{{
  "type": "hero|pricing|faq|testimonials|contact|features|gallery|generic",
  "builder": {{
    "divi": {{
      "module_type": "fullwidth_header|blurb_grid|pricing_tables|faq_accordion|testimonials|contact_form|code",
      "params": {{ ... freeform key/value pairs, or {{}} if unknown }}
    }}
  }}
}}

Guidance:

- "hero": top-of-page big header, usually with H1/H2 and primary CTA buttons.
  -> module_type: "fullwidth_header"
- "pricing": plans with prices and feature bullets.
  -> module_type: "pricing_tables"
- "faq": list of questions + answers.
  -> module_type: "faq_accordion"
- "testimonials": quotes from people, with names/roles.
  -> module_type: "testimonials"
- "contact": contact form, phone/email, addresses.
  -> module_type: "contact_form"
- A grid of cards/features/services.
  -> module_type: "blurb_grid"
- If nothing clearly matches, use:
  -> type: "generic", module_type: "code"

The "params" field should hold *parsed content* when obvious:
- For hero: "title", "subtitle", "primary_button_text", "primary_button_url", etc.
- For pricing: "plans": [{{"name", "price", "billing_period", "features": [...]}}, ...]
- For FAQ: "items": [{{"question", "answer"}}, ...]
- For testimonials: "items": [{{"quote", "author", "role"}}, ...]

If you are unsure, still choose the closest module_type but you may keep params as {{}}.

AGAIN: Output ONLY the JSON object, with no explanation, no markdown, no backticks.
"""
    return user_prompt


def build_checker_prompt(html: str, original_json: Dict[str, Any]) -> str:
    original = json.dumps(original_json, ensure_ascii=False)
    user_prompt = f"""We tried to classify a page section into a Divi Builder module.

Section HTML (truncated if long):
\"\"\"HTML
{html[:3000]}
\"\"\"HTML

Here is the FIRST JSON attempt:
{original}

This JSON must match this schema:

{{
  "type": "hero|pricing|faq|testimonials|contact|features|gallery|generic",
  "builder": {{
    "divi": {{
      "module_type": "fullwidth_header|blurb_grid|pricing_tables|faq_accordion|testimonials|contact_form|code",
      "params": {{ ... dict, can be empty }}
    }}
  }}
}}

If the JSON is already valid and consistent with the HTML, return it unchanged.
If it is missing keys, uses an invalid type/module, or clearly contradicts the HTML, return a corrected JSON object that does match the schema.

Output ONLY the final JSON object, with no extra text, no markdown, no backticks.
"""
    return user_prompt


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print("{}", end="")
        return

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        # If stdin is not JSON for some reason, treat it as raw HTML.
        payload = {"html": raw, "context": ""}

    html = payload.get("html", "")
    context = payload.get("context", "")

    tokenizer, model = load_model()

    system_prompt = (
        "You are an expert Divi / marketing-site IA, mapping HTML sections "
        "into Divi Builder modules with structured JSON."
    )
    user_prompt = build_prompt_html(html, context)
    full_prompt = apply_chat_template(tokenizer, system_prompt, user_prompt)

    # First pass
    text = run_model(tokenizer, model, full_prompt, max_new_tokens=512)

    try:
        json_str = extract_json(text)
        data = json.loads(json_str)
    except Exception as e:
        print(f"[llm_classifier] First-pass JSON extraction failed: {e}", file=sys.stderr)
        data = None

    # Checker / second pass if needed
    if data is None or needs_fix(data):
        try:
            checker_prompt = build_checker_prompt(html, data or {})
            full_checker_prompt = apply_chat_template(tokenizer, system_prompt, checker_prompt)
            text2 = run_model(tokenizer, model, full_checker_prompt, max_new_tokens=512)
            json_str2 = extract_json(text2)
            data2 = json.loads(json_str2)
            if not needs_fix(data2):
                data = data2
        except Exception as e:
            print(f"[llm_classifier] Checker failed: {e}", file=sys.stderr)

    # Final fall-back if still bad
    if data is None or needs_fix(data):
        data = {
            "type": "generic",
            "builder": {
                "divi": {
                    "module_type": "code",
                    "params": {},
                }
            },
        }

    # IMPORTANT: print JSON ONLY, once.
    print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
