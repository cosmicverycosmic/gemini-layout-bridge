const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// Model Config (Tier 1 Key)
const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta"; 

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v15.0 (Deep Extractor)`);
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');

        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

        // --- NEW: Data Extraction Prompt ---
        const systemPrompt = `
        ROLE: Expert WordPress Data Extractor & Layout Architect.
        TARGET: ${args.builder} (Divi/Elementor).
        
        TASK: Deeply analyze the React/Angular Source Code and extract CONTENT into structured JSON for WordPress modules.
        
        ⛔ CRITICAL RULES (DO NOT IGNORE):
        1. **NO RAW HTML DUMPING**: Do not just copy the source HTML into a 'code' block. You MUST extract the text, links, and images.
        2. **PRICING TABLES**: Find plans. Extract { title, price, currency, frequency, features[] }. Map to type: "pricing".
        3. **HERO SECTIONS**: Find the h1, subtitle, and CTA button. Map to type: "hero".
        4. **GRIDS/FEATURES**: Find repeating divs with icons/images. Map to type: "blurb_grid". Extract { title, content, icon/image }.
        5. **TESTIMONIALS**: Find quotes/authors. Map to type: "testimonial".
        6. **FAQ**: Find question/answer pairs. Map to type: "accordion".
        7. **IMAGES**: If you see an <img> tag, map to type: "image" and capture the 'src'.
        
        ECOSYSTEM:
        - If context has 'divi_machine' and you see a data.map(), use type: 'machine_loop'.
        
        OUTPUT SCHEMA (JSON ONLY):
        {
            "layout": {
                "sections": [
                    {
                        "type": "hero",
                        "props": {
                            "title": "Experience Intelligence",
                            "subtitle": "Ask questions about our services...",
                            "cta_text": "Ask Assistant",
                            "bg_color": "#0f172a" 
                        }
                    },
                    {
                        "type": "pricing",
                        "props": {
                            "items": [
                                { "title": "Starter", "price": "29", "currency": "$", "features": ["Feature A", "Feature B"] },
                                { "title": "Pro", "price": "99", "currency": "$", "features": ["All Features"] }
                            ]
                        }
                    }
                ]
            },
            "custom_plugin_php": null
        }`;

        const userMessage = `CONTEXT: ${contextRaw}\n\nSOURCE CODE:\n${codeSummary}`;

        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        console.log(`Sending Deep Extraction Request to ${MODEL_NAME}...`);

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { 
                    response_mime_type: "application/json",
                    temperature: 0.1 // Low temp for precision
                }
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        const rawText = data.candidates[0].content.parts[0].text;
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        let output;
        try {
            output = JSON.parse(cleanJson);
        } catch (e) {
            throw new Error("Failed to parse JSON: " + rawText.substring(0, 100));
        }

        // Save
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Extracted: ${output.layout.sections.length} semantic sections.`);

        if (output.custom_plugin_php && output.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error.message);
        process.exit(1); // Fail the job so we see the red X
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX_CHARS = 500000; 
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build', 'assets'].includes(file)) continue;
                walk(fullPath);
            } else if (file.match(/\.(js|jsx|ts|tsx|html|php|css)$/i)) {
                if (file.includes('lock') || file.includes('config')) continue;
                summary += `\n--- ${file} ---\n${fs.readFileSync(fullPath, 'utf8')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
