const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// Model Config (Stable Tier 1)
const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta"; 

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v16.0 (Deep Component Mapping)`);
        console.log(`Target: ${args.builder}`);
        console.log("----------------------------------------");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context missing.");
        const context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
        
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code: ${codeSummary.length} chars`);

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY missing.");

        const systemPrompt = `
        ROLE: Senior Divi Theme Architect.
        TASK: Convert React/Angular code into a structured JSON definition for Divi Builder.
        
        ⛔ STRICT PROHIBITION: 
        Do NOT put large blocks of HTML into a "text" or "code" module. You MUST decompose the UI into specific Divi modules.
        
        AVAILABLE MODULES & MAPPING RULES:
        1. **Hero/Header**: 
           - Look for: Big H1, Subtitle, Background Image/Color, CTA Button.
           - Map to: type="hero", props={ title, subtitle, button_text, background_image, background_color }.
        
        2. **Grids (Services/Features)**: 
           - Look for: Repeating divs with Icons + Title + Text.
           - Map to: type="blurb_grid", props={ items: [{ title, content, icon, image }] }.
        
        3. **Pricing**: 
           - Look for: Price cards (Currency, Amount, Period, Features List).
           - Map to: type="pricing", props={ items: [{ title, price, currency, frequency, features[] }] }.
        
        4. **FAQ/Accordion**: 
           - Look for: Question/Answer toggles or Description Lists (<dl>).
           - Map to: type="accordion", props={ items: [{ question, answer }] }.
        
        5. **Media**: 
           - Video: type="video", props={ src }.
           - Slider: type="slider", props={ slides: [{ heading, content, image }] }.
           - Gallery: type="gallery", props={ images: [] }.
        
        6. **Interactive**:
           - Counters: type="number_counter", props={ title, number, percent: true/false }.
           - Countdown: type="countdown", props={ title, date }.
           - Social: type="social_follow", props={ networks: [{ network, url }] }.
           - Contact Form: type="contact_form", props={ title, email }. (Map to 'gravity_form' if detected in context).
        
        7. **Ecosystem**:
           - WooCommerce Products -> type="shop".
           - Dynamic Blog/News -> type="blog".
        
        OUTPUT FORMAT (JSON ONLY):
        {
            "layout": {
                "sections": [
                    { "type": "hero", "props": { ... } },
                    { "type": "blurb_grid", "props": { "items": [...] } }
                ]
            },
            "custom_plugin_php": null
        }`;

        const userMessage = `CONTEXT: ${JSON.stringify(context)}\n\nCODE:\n${codeSummary}`;

        console.log(`Sending to ${MODEL_NAME}...`);

        const response = await fetch(`https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
            })
        });

        if (!response.ok) throw new Error(await response.text());

        const data = await response.json();
        const raw = data.candidates[0].content.parts[0].text;
        const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        const output = JSON.parse(clean);

        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Saved: ${output.layout.sections.length} sections.`);

        if (output.custom_plugin_php?.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
        }

    } catch (error) {
        console.error("ERROR:", error.message);
        const errJson = {
            sections: [{ type: 'text', props: { content: `<div style="color:red">AI Error: ${error.message}</div>` } }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errJson));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX = 600000;
    function walk(d) {
        if (summary.length >= MAX) return;
        const files = fs.readdirSync(d);
        for (const f of files) {
            const fp = path.join(d, f);
            if (fs.statSync(fp).isDirectory()) {
                if (!['node_modules', '.git', 'dist', 'build', 'assets'].includes(f)) walk(fp);
            } else if (f.match(/\.(js|jsx|ts|tsx|html|vue|php)$/i)) {
                if (!f.includes('test')) summary += `\n--- ${f} ---\n${fs.readFileSync(fp, 'utf8')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
