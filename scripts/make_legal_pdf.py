"""Converte il documento legale .md in PDF."""
from markdown_pdf import MarkdownPdf, Section

src = "/app/memory/documento_tecnico_legale_v69.md"
dst = "/app/memory/documento_tecnico_legale_v69.pdf"

with open(src, "r", encoding="utf-8") as f:
    md_content = f.read()

css = """
body {
    font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1a1a1a;
    padding: 20px 32px;
}
h1 {
    font-size: 22pt;
    color: #1F1A36;
    border-bottom: 3px solid #8B5CF6;
    padding-bottom: 8px;
    margin-top: 20px;
    margin-bottom: 20px;
}
h2 {
    font-size: 16pt;
    color: #1F1A36;
    margin-top: 28px;
    margin-bottom: 10px;
    border-bottom: 1px solid #ddd;
    padding-bottom: 4px;
}
h3 {
    font-size: 13pt;
    color: #333;
    margin-top: 18px;
    margin-bottom: 6px;
}
h4 {
    font-size: 11.5pt;
    color: #555;
    margin-top: 12px;
    margin-bottom: 4px;
}
p { margin: 6px 0 10px 0; }
ul, ol { margin: 6px 0 14px 20px; }
li { margin: 3px 0; }
code {
    background: #f4f4f8;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 9.5pt;
}
pre {
    background: #f4f4f8;
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 9pt;
    line-height: 1.4;
    border-left: 3px solid #8B5CF6;
}
blockquote {
    border-left: 3px solid #8B5CF6;
    margin: 10px 0;
    padding: 6px 14px;
    color: #444;
    background: #faf8ff;
    border-radius: 0 4px 4px 0;
}
table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 9.5pt;
}
th, td {
    border: 1px solid #ddd;
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
}
th {
    background: #1F1A36;
    color: #fff;
    font-weight: 600;
}
tr:nth-child(even) td {
    background: #faf9fc;
}
strong { color: #000; }
hr {
    border: none;
    border-top: 1px solid #ccc;
    margin: 20px 0;
}
"""

pdf = MarkdownPdf(toc_level=2, optimize=True)
pdf.meta["title"] = "Documento Tecnico-Legale Ollenya — v67.12"
pdf.meta["author"] = "Team Ollenya (L'Amico Fraterno)"
pdf.meta["subject"] = "Mappa per redazione ToS, Privacy Policy, Disclaimer"
pdf.add_section(Section(md_content, toc=True), user_css=css)
pdf.save(dst)

import os
print(f"OK: {dst} ({os.path.getsize(dst)/1024:.1f} KB)")
