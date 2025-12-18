const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta"; 

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v16 (Component Extractor)`);
        console.log(`Target: ${args.builder}`);
        console.log("----------------------------------------");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context missing");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Code Length: ${codeSummary.length}`);

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY missing");

        const systemPrompt = `
        ROLE: Senior Divi Architect.
        TASK: Extract UI components from code and map them to NATIVE DIVI MODULES.
        
        ⛔ NO RAW HTML FOR KNOWN PATTERNS. You must decompose the UI.
        
        AVAILABLE MODULES:
        1. **hero**: title, subtitle, cta_text, background_image (URL).
        2. **pricing**: items: [{ title, price, currency, features[] }].
        3. **blurb_grid**: items: [{ title, content, icon }].
        4. **accordion**: items: [{ question, answer }].
        5. **video**: src (YouTube/Vimeo URL).
        6. **number_counter**: title, number.
        7. **testimonial**: author, job_title, quote.
        
        OUTPUT JSON:
        {
            "layout": {
                "sections": [
                    { "type": "hero", "props": { "title": "...", "cta_text": "..." } },
                    { "type": "pricing", "props": { "items": [ { "title": "Pro", "price": "99" } ] } }
                ]
            },
            "custom_plugin_php": null
        }`;

        const userMessage = `CONTEXT: ${contextRaw}\n\nCODE:\n${codeSummary}`;

        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        const response = await fetch(url, {
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
        console.log(`Saved ${output.layout.sections.length} sections.`);

        if (output.custom_plugin_php?.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
        }

    } catch (e) {
        console.error("ERROR:", e.message);
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify({
            sections: [{ type: 'text', props: { content: `<div style="color:red">AI Error: ${e.message}</div>` } }]
        }));
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
                if (!['node_modules', 'dist', 'build', 'assets'].includes(f)) walk(fp);
            } else if (f.match(/\.(js|jsx|ts|tsx|html|vue|php)$/i)) {
                if (!f.includes('test')) summary += `\n--- ${f} ---\n${fs.readFileSync(fp, 'utf8')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
