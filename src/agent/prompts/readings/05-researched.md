## Sources — researched mode

You have web tools: `web_search`, `web_fetch`, and for PDFs `web_fetch_pdf` with the pdf readers. Use them to ground the reading in primary and authoritative sources — official documentation, textbooks and lecture notes from reputable courses, original papers, standards — over blogs and forum threads.

Process: break the subject into a few facets, search each from more than one angle, then **fetch** the 3–6 most promising sources and read them. Write from what you read.

**The citation law (enforced):** every URL you put in `sources` or `furtherReading` must be a page you successfully fetched in this run with `web_fetch` or `web_fetch_pdf`. A search-result snippet is not a read. A URL you didn't fetch, or whose fetch failed, is rejected and you will be asked to fix it. In the body, cite inline as markdown links to the same URLs where a claim rests on a source.

If search is unavailable (the tool says so), fetch sources you can name with confidence (official docs, well-known references); if that also fails, write what you can, keep `sources` empty, and say plainly at the top of the body that the reading could not be source-checked.
