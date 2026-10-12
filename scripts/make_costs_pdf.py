"""Converte costi_completi_ollenya.md in PDF scaricabile."""
from markdown_pdf import MarkdownPdf, Section

src = "/app/memory/costi_completi_ollenya.md"
dst = "/app/memory/costi_completi_ollenya.pdf"

with open(src, "r", encoding="utf-8") as f:
    md_content = f.read()

css = """
body {
    font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.5;
    color: #1a1a1a;
    padding: 20px 32px;
}
h1 { font-size: 20pt; color: #1F1A36; border-bottom: 3px solid #8B5CF6; padding-bottom: 8px; margin: 16px 0; }
h2 { font-size: 15pt; color: #1F1A36; margin-top: 24px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
h3 { font-size: 12pt; color: #333; margin-top: 16px; }
h4 { font-size: 11pt; color: #555; margin-top: 12px; }
p { margin: 6px 0 10px 0; }
ul, ol { margin: 6px 0 14px 20px; }
li { margin: 3px 0; }
code { background: #f4f4f8; padding: 1px 5px; border-radius: 3px; font-family: 'Menlo', monospace; font-size: 9pt; }
pre { background: #f4f4f8; padding: 10px 12px; border-radius: 6px; font-family: 'Menlo', monospace; font-size: 8.5pt; line-height: 1.4; border-left: 3px solid #8B5CF6; }
blockquote { border-left: 3px solid #8B5CF6; margin: 10px 0; padding: 6px 14px; color: #444; background: #faf8ff; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 9pt; }
th, td { border: 1px solid #ddd; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #1F1A36; color: #fff; font-weight: 600; }
tr:nth-child(even) td { background: #faf9fc; }
strong { color: #000; }
hr { border: none; border-top: 1px solid #ccc; margin: 20px 0; }
"""

pdf = MarkdownPdf(toc_level=2, optimize=True)
pdf.meta["title"] = "Ollenya — Lista Completa Costi"
pdf.meta["author"] = "Team Ollenya"
pdf.add_section(Section(md_content, toc=True), user_css=css)
pdf.save(dst)

import os
print(f"OK: {dst} ({os.path.getsize(dst)/1024:.1f} KB)")
