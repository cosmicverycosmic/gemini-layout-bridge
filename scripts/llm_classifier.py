#!/usr/bin/env python3
import os
import sys
import json
import re
import argparse
from typing import Any, Dict

from transformers import AutoTokenizer, AutoModelForCausalLM


# -------------------------------------------------------------------
# Divi module catalog
# -------------------------------------------------------------------

ALLOWED_DIVI_MODULES = [
    # Standard width modules
    "accordion",
    "audio",
    "bar_counters",
    "blurb",
    "blog",
    "button",
    "call_to_action",
    "circle_counter",
    "code",
    "comments",
    "contact_form",
    "countdown_timer",
    "divider",
    "email_optin",
    "filterable_portfolio",
    "gallery",
    "image",
    "login",
    "map",
    "number_counter",
    "person",
    "portfolio",
    "post_navigation",
    "post_slider",
    "post_title",
    "pricing_table",
    "search",
    "shop",
    "sidebar",
    "slider",
    "social_media_follow",
    "tabs",
    "testimonial",
    "text",
    "toggle",
    "video",
    "video_slider",

    # Fullwidth modules
    "fullwidth_code",
    "fullwidth_header",
    "fullwidth_image",
    "fullwidth_map",
    "fullwidth_menu",
    "fullwidth_post_title",
    "fullwidth_portfolio",
    "fullwidth_slider",
    "fullwidth_post_slider",

    # WooCommerce modules
    "woo_breadcrumb",
    "woo_cart_products",
    "woo_cart_totals",
    "woo_account",
    "woo_add_to_cart",
    "woo_billing",
    "woo_cart",
    "woo_checkout",
    "woo_checkout_billing",
    "woo_checkout_shipping",
    "woo_checkout_information",
    "woo_order_details",
    "woo_products",
    "woo_related_products",
    "woo_reviews",
    "woo_shipping",

    # Our meta-layout helpers
    "blurb_grid",
    "pricing_tables",
    "faq_accordion",
    "testimonials",
    "contact_form",
    "code",
]

PSEUDO_LAYOUT_MODULES = {
    "blurb_grid",
    "pricing_tables",
    "faq_accordion",
    "testimonials",
    "contact_form",
    "code",
}


# -------------------------------------------------------------------
# Prompt construction
# -------------------------------------------------------------------

def build_prompt_html(html: str) -> str:
    header = (
        "You are a strict JSON generator for a Divi Builder layout classifier.\n"
        "You MUST output ONE JSON object only, no commentary, no explanation.\n\n"
    )

    html_trimmed = html[:4000]

    user_prompt = f"""{header}You are classifying a single page section from a marketing or ecommerce website and deciding which Divi Builder module best fits.

Section HTML (truncated if long):
\"\"\"HTML
{html_trimmed}
\"\"\"HTML

Return a SINGLE JSON object only, with this exact schema:

{{
  "type": "hero|pricing|faq|testimonials|contact|features|gallery|generic",
  "builder": {{
    "divi": {{
      "module_type": "<one Divi module slug>",
      "params": {{ ... freeform key/value pairs, or {{}} if unknown }}
    }}
  }}
}}

The `module_type` MUST be one of:

Standard width modules:
accordion, audio, bar_counters, blurb, blog, button, call_to_action, circle_counter,
code, comments, contact_form, countdown_timer, divider, email_optin, filterable_portfolio,
gallery, image, login, map, number_counter, person, portfolio, post_navigation,
post_slider, post_title, pricing_table, search, shop, sidebar, slider,
social_media_follow, tabs, testimonial, text, toggle, video, video_slider.

Fullwidth modules:
fullwidth_code, fullwidth_header, fullwidth_image, fullwidth_map, fullwidth_menu,
fullwidth_post_title, fullwidth_portfolio, fullwidth_slider, fullwidth_post_slider.

WooCommerce modules:
woo_breadcrumb, woo_cart_products, woo_cart_totals, woo_account, woo_add_to_cart,
woo_billing, woo_cart, woo_checkout, woo_checkout_billing, woo_checkout_shipping,
woo_checkout_information, woo_order_details, woo_products, woo_related_products,
woo_reviews, woo_shipping.

Special layout-helper types we defined:
blurb_grid (grid of blurbs),
pricing_tables (multi-column pricing),
faq_accordion (multi Q&A),
testimonials (one or more testimonials),
contact_form (contact form),
code (raw HTML fallback).

Guidance:
- If the section is clearly a hero banner, pricing section, FAQ, testimonial block,
  contact block, or feature grid, prefer the matching layout-helper type.
- If it maps naturally to a single Divi module (e.g. blog list, shop, video),
  choose that concrete module_type (e.g. "blog", "woo_products", "video").
- If nothing clearly matches, set:
    "type": "generic"
    "builder.divi.module_type": "code"

The "params" object should contain parsed, structured content when obvious. Use simple
string or string-array values (no nested objects unless necessary).

Output rules (CRITICAL):
- Output ONLY one JSON object.
- Do NOT wrap it in backticks or code fences.
- Do NOT include any commentary before or after the JSON.
"""

    return user_prompt


# -------------------------------------------------------------------
# LLM invocation and JSON cleaning
# -------------------------------------------------------------------

def load_model():
    model_name = os.getenv("GLB_LLM_MODEL", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name)
    return tokenizer, model


def generate_raw(tokenizer, model, prompt: str) -> str:
    inputs = tokenizer(prompt, return_tensors="pt")
    outputs = model.generate(
        **inputs,
        max_new_tokens=512,
        do_sample=True,
        temperature=0.2,
        top_p=0.9,
        pad_token_id=getattr(tokenizer, "pad_token_id", tokenizer.eos_token_id),
    )
    text = tokenizer.decode(outputs[0], skip_special_tokens=True)
    return text


def extract_json(text: str) -> str:
    """
    Try to pull the first JSON object out of the model's text.
    """
    # Strip code fences if present
    fence_match = re.search(r"```(?:json)?(.*)```", text, flags=re.DOTALL | re.IGNORECASE)
    if fence_match:
        text = fence_match.group(1)

    # Find first {...} block
    brace_match = re.search(r"\{[\s\S]*\}", text)
    if not brace_match:
        raise ValueError("No JSON object found in model output")
    json_str = brace_match.group(0).strip()
    return json_str


def needs_fix(obj: Dict[str, Any]) -> bool:
    try:
        if not isinstance(obj, dict):
            return True
        t = obj.get("type")
        if t not in ["hero", "pricing", "faq", "testimonials", "contact", "features", "gallery", "generic"]:
            return True

        builder = obj.get("builder")
        if not isinstance(builder, dict):
            return True
        divi = builder.get("divi")
        if not isinstance(divi, dict):
            return True

        module_type = divi.get("module_type")
        if not isinstance(module_type, str) or module_type not in ALLOWED_DIVI_MODULES:
            return True

        # params must be dict if present
        params = divi.get("params", {})
        if not isinstance(params, dict):
            return True
        return False
    except Exception:
        return True


def normalize(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enforce schema and safe defaults.
    """
    if not isinstance(obj, dict):
        obj = {}

    t = obj.get("type")
    if t not in ["hero", "pricing", "faq", "testimonials", "contact", "features", "gallery", "generic"]:
        t = "generic"

    builder = obj.get("builder")
    if not isinstance(builder, dict):
        builder = {}

    divi = builder.get("divi")
    if not isinstance(divi, dict):
        divi = {}

    module_type = divi.get("module_type")
    if not isinstance(module_type, str) or module_type not in ALLOWED_DIVI_MODULES:
        module_type = "code"

    params = divi.get("params")
    if not isinstance(params, dict):
        params = {}

    return {
        "type": t,
        "builder": {
            "divi": {
                "module_type": module_type,
                "params": params,
            }
        },
    }


def classify_html_section(html: str) -> Dict[str, Any]:
    prompt = build_prompt_html(html)
    tokenizer, model = load_model()
    raw = generate_raw(tokenizer, model, prompt)
    json_str = extract_json(raw)

    try:
        obj = json.loads(json_str)
    except Exception as e:
        raise ValueError(f"Failed to parse JSON from model output: {e}")

    cleaned = normalize(obj)
    return cleaned


# -------------------------------------------------------------------
# CLI
# -------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Classify a single HTML section into Divi module metadata.")
    parser.add_argument(
        "--html-file",
        help="Path to a file containing the HTML for this section. If omitted, reads from stdin.",
    )
    args = parser.parse_args()

    if args.html_file:
        with open(args.html_file, "r", encoding="utf-8") as f:
            html = f.read()
    else:
        html = sys.stdin.read()

    if not html.strip():
        # Emit a safe fallback JSON
        fallback = {
            "type": "generic",
            "builder": {
                "divi": {
                    "module_type": "code",
                    "params": {},
                }
            },
        }
        print(json.dumps(fallback, ensure_ascii=False))
        return

    try:
        result = classify_html_section(html)
    except Exception as e:
        # Final safety net: emit generic code module so the worker never crashes
        fallback = {
            "type": "generic",
            "builder": {
                "divi": {
                    "module_type": "code",
                    "params": {
                        "_error": str(e),
                    },
                }
            },
        }
        print(json.dumps(fallback, ensure_ascii=False))
        return

    # IMPORTANT: stdout is JSON ONLY, no logs.
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
