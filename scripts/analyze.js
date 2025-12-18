const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

// Model Config: Using Tier 1 Stable/Preview Endpoint
const MODEL_NAME = "gemini-2.0-flash-lite-preview-02-05";
const API_VERSION = "v1beta"; 

async function run() {
    try {
        console.log("----------------------------------------");
        console.log(`GLB Architect v16.0 (Full Spectrum)`);
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Context & Source
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        const context = JSON.parse(contextRaw);
        
        console.log(`Context Loaded: ${context.site || 'WordPress Site'}`);
        const activePlugins = Object.keys(context.ecosystem).filter(k => context.ecosystem[k]);
        console.log(`Active Ecosystem: ${activePlugins.join(', ')}`);

        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");

        // 2. Build the "Menu" of Available Modules
        // We strictly define what the AI can use to ensure the PHP Renderer can handle it.
        const availableModules = [
            "text (generic text blocks)",
            "image (single images)",
            "blurb (icon + title + text)",
            "button (links/actions)",
            "cta (call to action blocks)",
            "pricing_tables (pricing plans)",
            "accordion (faq, collapse)",
            "testimonial (quotes)",
            "number_counter (stats)",
            "circle_counter (stats)",
            "countdown_timer",
            "video (embeds)",
            "social_follow",
            "divider"
        ];

        // 3. Conditional Ecosystem Logic
        let ecosystemInstructions = "";
        
        if (context.ecosystem.woocommerce) {
            availableModules.push("shop (WooCommerce Product Grid)");
            ecosystemInstructions += "- **Products/Store**: If you see a list of products, items with prices (that look like goods), or a 'Shop' section, use type: 'shop'.\n";
        } else {
            ecosystemInstructions += "- **Products**: WooCommerce is NOT active. Map products to 'blurb_grid' or 'pricing_tables'.\n";
        }

        if (context.ecosystem.divi_machine) {
            availableModules.push("machine_loop (Dynamic CPT Grid)");
            ecosystemInstructions += "- **Dynamic Data**: If you see a loop of custom data (projects, team members, real estate), use type: 'machine_loop' and specify the 'post_type'.\n";
        } else {
            availableModules.push("blog (Standard Post Grid)");
            ecosystemInstructions += "- **Blog/News**: Map news/articles to type: 'blog'.\n";
        }

        if (context.ecosystem.gravity_forms) {
            availableModules.push("gravity_form");
            ecosystemInstructions += "- **Forms**: Gravity Forms IS active. If you see a form, use type: 'gravity_form'.\n";
        } else {
            availableModules.push("contact_form");
            ecosystemInstructions += "- **Forms**: Gravity Forms is NOT active. Map forms to type: 'contact_form' (Native Divi).\n";
        }

        // 4. Construct the System Prompt
        const systemPrompt = `
        ROLE: Expert WordPress Divi Architect.
        TARGET: ${args.builder}.
        
        TASK: Deeply parse the provided React/Angular source code and map it to NATIVE DIVI MODULES.
        GOAL: The output must be editable in the Visual Builder. Avoid raw HTML ("code" module) unless absolutely necessary.

        AVAILABLE MODULES:
        ${availableModules.join(', ')}

        ECOSYSTEM LOGIC:
        ${ecosystemInstructions}

        EXTRACTION RULES:
        1. **Props Extraction**: For every section, extract the *actual text content* into 'props'. 
           - For Blurbs: extract 'title', 'content', 'icon' (guess a FontAwesome name).
           - For Heroes: extract 'title', 'subtitle', 'button_text', 'background_image'.
           - For Testimonials: extract 'author', 'job_title', 'quote'.
        2. **Layout Structure**: 
           - Group related items (like 3 feature cards) into a single section with type 'blurb_grid'.
           - Group FAQs into a single section with type 'accordion'.
        3. **Images**: Keep original filenames in 'props.src'. The system will handle importing.

        OUTPUT SCHEMA (JSON):
        {
            "layout": {
                "sections": [
                    {
                        "type": "hero | blurb_grid | pricing_tables | accordion | shop | blog | contact_form | ...",
                        "props": {
                            "title": "Page Title",
                            "subtitle": "...",
                            "items": [ 
                                { "title": "Card 1", "content": "...", "icon": "user" },
                                { "title": "Card 2", "content": "...", "icon": "settings" }
                            ]
                        }
                    }
                ]
            },
            "custom_plugin_php": null
        }
        `;

        const userMessage = `CONTEXT: ${contextRaw}\n\nSOURCE CODE:\n${codeSummary}`;

        // 5. Send Request (Raw Fetch)
        const url = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
        
        console.log(`Sending Extraction Request to ${MODEL_NAME}...`);

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt + "\n\n" + userMessage }] }],
                generationConfig: { 
                    response_mime_type: "application/json",
                    temperature: 0.1 
                }
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Gemini API Error (${response.status}): ${errBody}`);
        }

        const data = await response.json();
        const rawText = data.candidates[0].content.parts[0].text;
        
        // 6. Clean & Parse
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        let output;
        try {
            output = JSON.parse(cleanJson);
        } catch (e) {
            throw new Error("Failed to parse JSON: " + rawText.substring(0, 100));
        }

        // 7. Save
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(output.layout, null, 2));
        console.log(`Layout Generated: ${output.layout.sections.length} sections mapped to native modules.`);

        if (output.custom_plugin_php && output.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, output.custom_plugin_php);
            console.log("Custom Logic Plugin generated.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error.message);
        // Error artifact
        const errorLayout = {
            sections: [{ 
                type: 'text', 
                props: { content: `<h3>AI Conversion Failed</h3><p>${error.message}</p>` } 
            }] 
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0); // Exit 0 to ensure artifacts upload to WP
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX_CHARS = 600000; // Large context allowed for Tier 1
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build', 'assets', 'public'].includes(file)) continue;
                walk(fullPath);
            } else if (file.match(/\.(js|jsx|ts|tsx|html|php|vue)$/i)) {
                if (file.includes('lock') || file.includes('config') || file.includes('test')) continue;
                summary += `\n--- FILE: ${file} ---\n${fs.readFileSync(fullPath, 'utf8')}\n`;
            }
        }
    }
    walk(dir);
    return summary;
}

run();
