#!/usr/bin/env python3
import json
import os
import re
import sys
from typing import Any, Dict

from transformers import AutoTokenizer, AutoModelForCausalLM

MODEL_NAME = os.getenv("GLB_LLM_MODEL", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")

DIVI_MODULES = [
    {"key": "section_row_column", "tag": "generic", "description": "Generic section+row+column wrapper, used with other modules."},

    # Common content modules
    {"key": "text", "tag": "et_pb_text", "description": "Body copy, paragraphs, headings and simple inline content."},
    {"key": "button", "tag": "et_pb_button", "description": "Standalone call-to-action button."},
    {"key": "image", "tag": "et_pb_image", "description": "Prominent images or logos."},
    {"key": "fullwidth_header", "tag": "et_pb_fullwidth_header", "description": "Hero sections with headline, subheadline, background, and buttons."},
    {"key": "slider", "tag": "et_pb_slider", "description": "Hero/feature sections that cycle through slides."},
    {"key": "cta", "tag": "et_pb_cta", "description": "Call-to-action strips with title, copy, and a button."},

    # Structured grids
    {"key": "blurb", "tag": "et_pb_blurb", "description": "Service/features grid: icon + title + short description per item."},
    {"key": "pricing_tables", "tag": "et_pb_pricing_tables", "description": "Pricing tables, packages, tiers with bullet features."},
    {"key": "faq_accordion", "tag": "et_pb_accordion", "description": "Expandable FAQ / Q&A sections."},
    {"key": "tabs", "tag": "et_pb_tabs", "description": "Tabbed content areas."},
    {"key": "testimonials", "tag": "et_pb_testimonial", "description": "Testimonials, quotes, customer names, roles."},
    {"key": "person", "tag": "et_pb_person", "description": "Individual person/author cards with name, role, description, and avatar."},

    # Contact / map
    {"key": "contact_form", "tag": "et_pb_contact_form", "description": "Contact forms, inquiry forms, lead capture forms."},
    {"key": "map", "tag": "et_pb_map", "description": "Maps or location sections."},

    # Media
    {"key": "video", "tag": "et_pb_video", "description": "Single video embeds."},
    {"key": "gallery", "tag": "et_pb_gallery", "description": "Image galleries or grids of thumbnails."},

    # Fallback
    {"key": "code", "tag": "code", "description": "Raw HTML/JS when nothing else fits. Use ONLY as a fallback."},
]


def load_model():
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    return tokenizer, model


def build_prompt(data: Dict[str, Any]) -> str:
    modules_desc = []
    for m in DIVI_MODULES:
        modules_desc.append(f"- key: {m['key']}, tag: {m['tag']}, use_for: {m['description']}")
    modules_block = "\n".join(modules_desc)

    prompt = []
    prompt.append("You are an expert Divi 4 layout architect.")
    prompt.append("You receive pre-split sections from a React/Angular single-page app.")
    prompt.append("For each section, you MUST:")
    prompt.append("1. Decide which Divi module best represents the section content.")
    prompt.append("2. Extract structured params for that module from the HTML/text.")
    prompt.append("3. ONLY fall back to the 'code' module when nothing else fits.")
    prompt.append("")
    prompt.append("Available Divi module keys:")
    prompt.append(modules_block)
    prompt.append("")
    prompt.append(
        "Return ONE JSON object only, with this schema:\n"
        "{\n"
        '  "sections": [\n'
        "    {\n"
        '      "id": string,\n'
        '      "type": string,\n'
        '      "divi": {\n'
        '        "module_type": string,\n'
        '        "params": {\n'
        "          // For fullwidth_header: title, subtitle, button_one_text, button_one_url, button_two_text, button_two_url, background_image, background_color\n"
        "          // For blurb: items: [{ title, body, icon_hint }]\n"
        "          // For pricing_tables: plans: [{ name, tagline, price, billing_period, features: [..], button_text, button_url, highlighted }]\n"
        "          // For faq_accordion: items: [{ question, answer }]\n"
        "          // For testimonials: items: [{ quote, author, role }]\n"
        "          // For contact_form: title, description, success_message\n"
        "          // For map: address, zoom, pin_label\n"
        "          // For text: content\n"
        "          // For image: src, alt\n"
        "          // For button: button_text, url\n"
        "          // For code: html_summary\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "  ]\n"
        "}\n"
    )
    prompt.append("")
    prompt.append("Sections to classify:\n")

    for idx, sec in enumerate(data.get("sections", [])):
        sid = sec.get("id", f"sec{idx}")
        s_type = sec.get("type", "generic")
        text_hint = sec.get("text", "")
        html = sec.get("html", "")

        prompt.append(f"SECTION {idx}")
        prompt.append(f"ID: {sid}")
        prompt.append(f"TYPE_HINT: {s_type}")
        prompt.append("TEXT_SNIPPET:")
        prompt.append(text_hint[:400])
        prompt.append("HTML_SNIPPET:")
        prompt.append(html[:1200])
        prompt.append("----")

    prompt.append(
        "Now output ONLY that JSON object. "
        "No markdown, no explanation, no backticks, no comments. Pure JSON."
    )

    return "\n".join(prompt)


def clean_json_like(text: str) -> str:
    """
    Try to coerce a slightly-wrong JSON-ish string into valid JSON:
    - strip ```json fences
    - strip line comments
    - strip /* ... */ block comments
    - remove trailing commas before ] or }
    """
    # Strip markdown fences
    text = re.sub(r"```json", "", text, flags=re.IGNORECASE)
    text = text.replace("```", "")

    # Extract from first { to last }
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise RuntimeError("LLM output did not contain a JSON object")
    s = m.group(0)

    # Remove // comments
    s = re.sub(r"//.*", "", s)

    # Remove /* ... */ comments
    s = re.sub(r"/\*[\s\S]*?\*/", "", s)

    # Remove trailing commas before ] or }
    s = re.sub(r",(\s*[\]}])", r"\1", s)

    return s.strip()


def generate_json(tokenizer, model, prompt: str) -> Dict[str, Any]:
    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=4096)
    outputs = model.generate(
        **inputs,
        max_new_tokens=2048,
        do_sample=False,
        pad_token_id=tokenizer.eos_token_id,
    )
    text = tokenizer.decode(outputs[0], skip_special_tokens=True)

    cleaned = clean_json_like(text)
    return json.loads(cleaned)


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"sections": []}))
        return

    data = json.loads(raw)

    tokenizer, model = load_model()
    prompt = build_prompt(data)

    try:
        result = generate_json(tokenizer, model, prompt)
    except Exception as e:
        # Dump raw text to stderr to debug if needed
        sys.stderr.write(f"[llm_classifier] Failed to parse JSON: {e}\n")
        raise

    if "sections" not in result or not isinstance(result["sections"], list):
        raise RuntimeError("Result JSON missing 'sections' list.")

    print(json.dumps(result))


if __name__ == "__main__":
    main()
