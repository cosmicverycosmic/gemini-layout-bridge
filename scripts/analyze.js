const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const OpenAI = require('openai');
const args = require('minimist')(process.argv.slice(2));

// File Constants
const SOURCE_ZIP = 'source.zip';
const CONTEXT_FILE = 'context.json';
const OUTPUT_LAYOUT = 'layout.json';
const OUTPUT_PLUGIN = 'plugin.php';

async function run() {
    try {
        console.log("----------------------------------------");
        console.log("GLB Architect v12 (GitHub Native)");
        console.log(`Target Builder: ${args.builder}`);
        console.log("----------------------------------------");

        // 1. Load Context & Source
        if (!fs.existsSync(CONTEXT_FILE)) throw new Error("Context file missing.");
        const contextRaw = fs.readFileSync(CONTEXT_FILE, 'utf8');
        
        const zip = new AdmZip(SOURCE_ZIP);
        zip.extractAllTo('extracted_source', true);
        const codeSummary = generateCodeSummary('extracted_source');
        console.log(`Source Code Scanned: ${codeSummary.length} chars`);

        // 2. Initialize OpenAI Client with GitHub Endpoint
        const token = process.env.GITHUB_TOKEN;
        if (!token) throw new Error("GITHUB_TOKEN is missing.");

        console.log("Connecting to models.github.ai/inference...");

        const client = new OpenAI({
            baseURL: "https://models.github.ai/inference",
            apiKey: token
        });

        // 3. Engineering Prompt
        const systemPrompt = `
        YOU ARE: A Senior WordPress Architect.
        TARGET BUILDER: ${args.builder}.
        
        TASK: Map React/Angular source code to a Native WordPress Layout.
        
        RULES:
        1. **Native Modules**: Use specific types like "pricing", "accordion", "hero", "blurb_grid", "video".
        2. **Ecosystem**: If 'divi_machine' is active, use 'machine_loop'. If 'woocommerce', use 'shop_grid'.
        3. **Security**: Wrap DB writes in 'if (!defined("GLB_PREVIEW_MODE"))'.
        
        OUTPUT FORMAT (JSON ONLY):
        {
            "layout": {
                "sections": [
                    { "type": "hero|pricing|text", "props": {"title":"..."}, "html": "..." }
                ]
            },
            "custom_plugin_php": "<?php ..."
        }`;

        const userMessage = `
        SITE CONTEXT: ${contextRaw}
        SOURCE CODE:
        ${codeSummary}
        `;

        // 4. Send Request
        // We use "gpt-4o" which is the standard identifier. 
        // If your specific access requires "openai/gpt-4o", the SDK usually handles the mapping, 
        // but we will try the standard first.
        const response = await client.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            model: "gpt-4o", 
            temperature: 0.1,
            max_tokens: 4096,
            response_format: { type: "json_object" }
        });

        const text = response.choices[0].message.content;
        console.log("✅ AI Response Received.");

        // 5. Parse & Save
        const data = JSON.parse(text);
        
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(data.layout, null, 2));
        console.log(`Layout Saved: ${data.layout.sections.length} sections.`);

        if (data.custom_plugin_php && data.custom_plugin_php.length > 50) {
            fs.writeFileSync(OUTPUT_PLUGIN, data.custom_plugin_php);
            console.log("Custom Plugin Saved.");
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        // If 401/403, it means the GITHUB_TOKEN is still restricted.
        const msg = error.status === 401 || error.status === 403 
            ? "Permission Denied: Ensure 'GitHub Models' is enabled for this user/org." 
            : error.message;

        const errorLayout = {
            sections: [{
                type: 'text',
                props: {},
                html: `<div style="padding:50px;color:red;border:2px solid red;"><h3>AI Error</h3><p>${msg}</p></div>`
            }]
        };
        fs.writeFileSync(OUTPUT_LAYOUT, JSON.stringify(errorLayout));
        process.exit(0);
    }
}

function generateCodeSummary(dir) {
    let summary = "";
    const MAX_CHARS = 100000; 
    
    function walk(directory) {
        if (summary.length >= MAX_CHARS) return;
        const files = fs.readdirSync(directory);
        for (const file of files) {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (['node_modules', '.git', 'build', 'dist', 'assets', 'vendor'].includes(file)) continue;
                walk(fullPath);
            } else {
                if (file.match(/\.(js|jsx|ts|tsx|html|php)$/i)) {
                    // Skip config/lock files
                    if(file.includes('config') || file.includes('lock')) continue;
                    const content = fs.readFileSync(fullPath, 'utf8');
                    summary += `\n--- ${file} ---\n${content.replace(/\s+/g, ' ')}\n`;
                }
            }
        }
    }
    walk(dir);
    return summary;
}

run();
