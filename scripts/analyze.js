const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

async function run() {
    try {
        console.log("----------------------------------------");
        console.log("GLB Enterprise Architect v9.0");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Site Context
        if (!fs.existsSync(CONTEXT_FILE)) {
            throw new Error("Context file missing.");
        }
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        const context = JSON.parse(contextRaw);
        console.log(`Context Loaded for: ${context.site_name}`);

        // 2. Extract and Summarize Source Code
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Summarized. Length: ${codeSummary.length} chars`);

        // 3. Initialize Gemini
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Using Pro model for better code generation capabilities
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

        // 4. Construct the Engineering Prompt
        const systemPrompt = `
        YOU ARE: A Senior WordPress Full-Stack Architect & Security Engineer.
        
        INPUTS:
        1. Modern Frontend Source Code (React/Angular/Vue).
        2. WordPress Site Inventory (Plugins, Assets, DB Capabilities).
        3. Target Builder: ${args.builder}.
        
        YOUR GOAL: 
        Convert the App into a native WordPress implementation.
        
        ---
        
        PHASE 1: LAYOUT MAPPING (JSON)
        Map the UI components to WordPress modules based on the Inventory.
        
        ECOSYSTEM RULES (PRIORITY HIGH):
        - If 'divi_machine' is true: Use 'machine_loop' type for any data lists/grids.
        - If 'divi_next' is true: Use 'next_tilt' for cards with hover effects.
        - If 'dp_carousel' is true: Use 'dp_slider' for carousels.
        - If 'gravity_forms' is true: Use 'contact_form' type mapped to gravity shortcodes.
        - If 'woocommerce' is true: Map product grids to 'shop_grid'.
        - If 'menus' are available: Map navbars to 'menu' type using the slug.
        
        PHASE 2: CUSTOM PLUGIN ENGINEERING (PHP)
        If the App contains logic that CANNOT be achieved with existing plugins (e.g., Mortgage Calculator, Task Database, Custom API integrations), you must WRITE A WORDPRESS PLUGIN to handle it.
        
        PHP SECURITY RULES:
        1. Nonces: Verify nonces on all form submissions.
        2. Sanitization: Use sanitize_text_field, sanitize_email, etc.
        3. Escape: Use esc_html, esc_attr on output.
        4. **SANDBOX PROTOCOL**: Wrap ALL database write operations (wp_insert_post, $wpdb->insert) in this check:
           if ( ! defined( 'GLB_PREVIEW_MODE' ) ) { ... }
           This allows the code to be previewed safely without modifying the DB.
        
        OUTPUT FORMAT (Strict JSON):
        {
            "layout": {
                "sections": [
                    { 
                        "type": "hero|machine_loop|next_tilt|shop_grid|contact_form|custom_shortcode|text", 
                        "props": { "title": "...", "shortcode": "[glb_calc]" }, 
                        "html": "fallback html" 
                    }
                ]
            },
            "custom_plugin_php": "<?php ... full valid plugin code including header ... ?>"
        }
        `;

        const userMessage = `
        SITE CONTEXT:
        ${contextRaw}

        SOURCE CODE SUMMARY:
        ${codeSummary}
        `;

        console.log("Sending Analysis Request to Gemini...");
        const result = await model.generateContent([systemPrompt, userMessage]);
        const response = result.response;
        let text = response.text();

        // Clean Markdown formatting if Gemini adds it
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // Parse Response
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error("Failed to parse JSON response from Gemini. Raw text:", text);
            throw new Error("Invalid JSON from AI");
        }

        // Save Layout
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(data.layout, null, 2));
        console.log(`Generated Layout: ${data.layout.sections.length} sections.`);

        // Save Plugin if exists
        if (data.custom_plugin_php && data.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, data.custom_plugin_php);
            console.log("Generated Custom Plugin: plugin.php saved.");
        } else {
            console.log("No custom plugin logic required.");
        }

    } catch (error) {
        console.error("CRITICAL ARCHITECT ERROR:", error);
        // Fallback Error Layout
        const errorLayout = {
            sections: [{
                type: 'text',
                props: {},
                html: `<div style="padding:50px;text-align:center;color:red;border:1px solid red;"><h3>AI Analysis Failed</h3><p>${error.message}</p></div>`
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

/**
 * Scans directory for source code, skipping node_modules and assets.
 * Returns a concatenated string of relevant code files.
 */
function generateCodeSummary(dir) {
    let summary = "";
    const MAX_CHARS = 100000; // Large context window allowed
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'build', 'dist', 'assets', 'images', 'vendor'].includes(file)) continue;
                walk(fullPath);
            } else {
                // Only read Logic/UI files
                if (file.match(/\.(js|jsx|ts|tsx|html|vue|php)$/i)) {
                    // Skip test/config files to save tokens
                    if (file.includes('test') || file.includes('spec') || file.includes('config')) continue;
                    
                    const content = fs.readFileSync(fullPath, 'utf8');
                    // Simple whitespace minification
                    const cleanContent = content.replace(/\s+/g, ' ');
                    
                    summary += `\n--- FILE: ${file} ---\n${cleanContent}\n`;
                    if (summary.length >= MAX_CHARS) break;
                }
            }
        }
    }

    walk(dir);
    return summary;
}

run();
