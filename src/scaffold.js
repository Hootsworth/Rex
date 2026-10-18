import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

const TEMPLATES = {
    'HTML File': '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Document</title>\n</head>\n<body>\n  \n</body>\n</html>',
    'React Component': 'import React from "react";\n\nexport default function ComponentName() {\n  return (\n    <div>\n      ComponentName\n    </div>\n  );\n}\n',
    'Node.js Express App': 'import express from "express";\n\nconst app = express();\nconst port = process.env.PORT || 3000;\n\napp.use(express.json());\n\napp.get("/", (req, res) => {\n  res.send("Hello World!");\n});\n\napp.listen(port, () => {\n  console.log(`Server listening on port ${port}`);\n});\n',
    'Python Script': 'def main():\n    print("Hello, World!")\n\nif __name__ == "__main__":\n    main()\n'
};

export async function quickScaffold() {
    const templateType = await p.select({
        message: 'What kind of file would you like to scaffold?',
        options: Object.keys(TEMPLATES).map(k => ({ value: k, label: k }))
    });

    if (p.isCancel(templateType)) {
        p.log.warn('Scaffold cancelled.');
        return;
    }

    const filename = await p.text({
        message: 'Enter output filename (e.g., index.html, App.jsx):',
        validate: (val) => {
            if (val.trim() === '') return 'Filename is required';
        }
    });

    if (p.isCancel(filename)) {
        p.log.warn('Scaffold cancelled.');
        return;
    }

    let outPath = filename;
    let componentName = path.basename(filename, path.extname(filename));

    // Fix component name for React template
    let content = TEMPLATES[templateType];
    if (templateType === 'React Component') {
        const capitalName = componentName.charAt(0).toUpperCase() + componentName.slice(1);
        content = content.replace(/ComponentName/g, capitalName);
    }

    try {
        fs.writeFileSync(outPath, content, 'utf-8');
        p.log.success(pc.green(`Successfully scaffolded ${outPath}!`));
    } catch (e) {
        p.log.error(pc.red(`Failed to write file: ${e.message}`));
    }
}
