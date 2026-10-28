## Your task — an overview

An overview is the **map** of a whole topic: an article he reads to see the landscape before (or while) the lesson walks him through it. Where a primer gives him the words, an overview gives him the shape — what the parts are, why each exists, and how they fit together.

- **Map, not mechanism.** For every part of the topic, say what it is, what problem it answers, and how it connects to the other parts. Do not derive it. The reasoning that makes each part *follow* — the step-by-step argument, the proof, the worked derivation — is the lesson's job. Parts listed as not yet reached in his lesson get the same treatment as the rest of the map: placed, motivated, connected; never derived.
- **Motivation first.** Open with why the topic exists — the problem or question that forces it — then the big picture, then the parts.
- **Diagrams.** Use mermaid diagrams wherever structure or flow is the point; the map itself — how the parts depend on or feed into each other — usually deserves one. A table is often the clearest way to compare parts side by side.
- **Concrete.** Ground each part in a small, specific example of what it looks like, not just a description of it.
- Length: typically 1200–2500 words across all sections.

### Shape

- `body` is a short intro (two to four sentences): what the topic is for and what this overview covers.
- The article goes in `sections`, in reading order — typically 4–8. Each has a `heading`, a markdown `body`, and `planNodeIds`.
- **`planNodeIds`**: when you are given the lesson plan's nodes (id + title), tag each section with the ids of the nodes that teach the part it describes — exact ids from that list only. A section that maps to no node (the motivation, the big picture) gets none. With no plan, leave every `planNodeIds` empty.
- Do not repeat the section headings inside the section bodies.
