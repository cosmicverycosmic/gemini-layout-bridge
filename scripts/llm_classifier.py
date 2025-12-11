#!/usr/bin/env python3
import sys
import json
import os
import re
from typing import Any, Dict, Optional

from transformers import AutoTokenizer, AutoModelForCausalLM
import torch

# -------------- Helpers --------------


def read_stdin_payload() -> Dict[str, Any]:
    data = sys.stdin.read()
    if not data.strip():
        raise ValueError("No stdin payload.")
    return json.loads(data)


def normalize_whitespace(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def allowed_module_types() -> set:
    """
    High-level 'module_type' labels we support.
    These get mapped to actual Divi modules in PHP.
    """
    return {
        "hero",
        "feature_grid",
        "steps_grid",
        "pricing_table",
        "testimonials_slider",
        "contact_form",
        "nav",
        "footer",
        "code",
        "generic",
    }


# -------------- Heuristic classifier --------------


def heuristic_classify(html: str) -> Optional[Dict[str, Any]]:
    """
    Cheap, deterministic mapping for common patterns.
    Returns a classifier-style dict or None if unsure.
    """
    text = normalize_whitespace(
        re.sub(r"<[^>]+>", " ", html)  # strip tags for text heuristics
    ).lower()

    # Very simple heuristics tuned for your InstantPlugins / Gemini Bridge page

    # Pricing table
    if "pricing" in text and "$" in text:
        return {
            "type": "pricing",
            "builder": {
                "divi": {
                    "module_type": "pricing_table",
                    "params": {
                        "columns": 2,
                        "has_primary_plan": True,
                    },
                }
            },
            "source": "heuristic",
        }

    # Testimonials / social proof
    if "testimonial" in text or "what our clients say" in text or "saved me hours" in text:
        return {
            "type": "testimonials",
            "builder": {
                "divi": {
                    "module_type": "testimonials_slider",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Contact / CTA form
    if ("contact" in text or "send message" in text) and (
        "email" in text or "message" in text or "form" in text
    ):
        return {
            "type": "contact",
            "builder": {
                "divi": {
                    "module_type": "contact_form",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Steps / "How it works"
    if "how it works" in text or "three steps" in text or "step 01" in text:
        return {
            "type": "steps",
            "builder": {
                "divi": {
                    "module_type": "steps_grid",
                    "params": {
                        "columns": 3,
                    },
                }
            },
            "source": "heuristic",
        }

    # Features grid
    if "features" in text and ("why use" in text or "bridge" in text):
        return {
            "type": "features",
            "builder": {
                "divi": {
                    "module_type": "feature_grid",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Hero / top-of-page marketing block
    if (
        "wordPress in seconds" in text
        or "gemini pro layouts" in text
        or "stop rebuilding ai designs" in text
    ):
        return {
            "type": "hero",
            "builder": {
                "divi": {
                    "module_type": "hero",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Security highlight (still mostly text + button)
    if "secure by design" in text or "no api keys required" in text:
        return {
            "type": "generic",
            "builder": {
                "divi": {
                    "module_type": "feature_grid",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Footer
    if "&copy" in text or "all rights reserved" in text:
        return {
            "type": "footer",
            "builder": {
                "divi": {
                    "module_type": "footer",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Nav
    if "#pricing" in text or "#features" in text or "#how-it-works" in text:
        return {
            "type": "nav",
            "builder": {
                "divi": {
                    "module_type": "nav",
                    "params": {},
                }
            },
            "source": "heuristic",
        }

    # Unsure
    return None


# -------------- LLM setup --------------


_model = None
_tokenizer = None


def get_model_and_tokenizer():
    global _model, _tokenizer
    if _model is not None and _tokenizer is not None:
        return _model, _tokenizer

    model_name = os.getenv("GLB_LLM_MODEL", "microsoft/Phi-3-mini-4k-instruct")
    print(f'[llm_classifier] Loading model: {model_name}', file=sys.stderr)

    _tokenizer = AutoTokenizer.from_pretrained(model_name)
    _model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32,
    )
    if torch.cuda.is_available():
        _model.to("cuda")

    return _model, _tokenizer


def extract_json(text: str) -> str:
    """
    Grab the first {...} block from the model output.
    """
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        return m.group(0)
    return text.strip()


def llm_classify(html: str, context: str) -> Dict[str, Any]:
    model, tokenizer = get_model_and_tokenizer()

    # Trim html so we don't blow the context
    trimmed_html = html
    if len(trimmed_html) > 4000:
        trimmed_html = trimmed_html[:4000] + "\n<!-- TRUNCATED -->"

    system_prompt = (
        "You classify HTML/JSX page sections into layout types and Divi modules.\n"
        "Divi is a WordPress page builder with modules like: Text, Button, Image, Blurb, "
        "Slider, Testimonial, Pricing Table, Contact Form, Tabs, Code, etc.\n\n"
        "Given a snippet, decide what KIND of section it is (hero, features grid, steps, "
        "pricing, testimonials, contact form, nav, footer, or generic) and which Divi module "
        "is the best primary representation.\n\n"
        "Prefer real content modules (Text, Blurb, Slider, Testimonial, Pricing Table, "
        "Contact Form, etc.) over Code. Only use Code if the content is heavily dynamic "
        "and cannot reasonably be mapped to normal Divi modules.\n\n"
        "Respond ONLY with a single JSON object of this shape:\n"
        '{\n'
        '  "type": "hero | features | steps | pricing | testimonials | contact | nav | footer | generic",\n'
        '  "builder": {\n'
        '    "divi": {\n'
        '      "module_type": "hero | feature_grid | steps_grid | pricing_table | testimonials_slider | contact_form | nav | footer | code | generic",\n'
        '      "params": { /* small key/value settings, optional */ }\n'
        '    }\n'
        '  }\n'
        '}\n'
        "Do not include any explanations, comments, or markdown – ONLY JSON."
    )

    user_prompt = (
        f"Context: {context}\n\n"
        "Section HTML/JSX:\n"
        "-----------------\n"
        f"{trimmed_html}\n"
        "-----------------\n"
        "Classify this section now."
    )

    # Simple chat-style prompt
    inputs = tokenizer(
        system_prompt + "\n\n" + user_prompt,
        return_tensors="pt",
        truncation=True,
    )
    if torch.cuda.is_available():
        inputs = {k: v.to("cuda") for k, v in inputs.items()}

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=256,
            temperature=0.2,
            top_p=0.9,
        )
    out_text = tokenizer.decode(output_ids[0], skip_special_tokens=True)

    json_str = extract_json(out_text)
    try:
        data = json.loads(json_str)
    except Exception:
        raise ValueError(f"Failed to parse LLM JSON: {json_str}")

    data["source"] = "llm"
    return data


def normalize_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Ensure minimal structure and clamp module_type to allowed set.
    """
    if not isinstance(result, dict):
        result = {}

    rtype = result.get("type") or "generic"
    builder = result.get("builder") or {}
    divi = builder.get("divi") or {}

    module_type = divi.get("module_type") or "generic"
    allowed = allowed_module_types()
    if module_type not in allowed:
        # If it's clearly some content-like thing, prefer generic rather than code.
        module_type = "generic" if module_type != "code" else "code"

    divi["module_type"] = module_type
    if "params" not in divi or not isinstance(divi["params"], dict):
        divi["params"] = {}

    builder["divi"] = divi
    result["builder"] = builder
    result["type"] = rtype

    # default source if missing
    if "source" not in result:
        result["source"] = "llm"

    return result


def main():
    try:
        payload = read_stdin_payload()
    except Exception as e:
        print(f"[llm_classifier] Failed to read stdin: {e}", file=sys.stderr)
        sys.exit(1)

    html = payload.get("html", "")
    context = payload.get("context", "")

    if not html.strip():
        print(
            json.dumps(
                {
                    "type": "generic",
                    "builder": {"divi": {"module_type": "code", "params": {}}},
                    "source": "empty",
                }
            )
        )
        return

    # 1) Try heuristics first
    heuristic = heuristic_classify(html)
    if heuristic is not None:
        result = normalize_result(heuristic)
        print(json.dumps(result))
        return

    # 2) Fall back to LLM
    try:
        raw = llm_classify(html, context)
    except Exception as e:
        print(f"[llm_classifier] LLM error: {e}", file=sys.stderr)
        # Last-resort fallback
        fallback = {
            "type": "generic",
            "builder": {"divi": {"module_type": "code", "params": {}}},
            "source": "fallback_error",
        }
        print(json.dumps(fallback))
        return

    result = normalize_result(raw)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
