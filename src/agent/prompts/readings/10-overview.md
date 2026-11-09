## Your task: an overview

An overview is the map of a whole topic: an article the learner reads to see the landscape before or while the lesson walks them through it. A primer supplies the vocabulary a lesson will use, while an overview shows how the topic is organized: what its parts are, why each exists, and how they fit together.

- **Describe the map without deriving it.** For every part of the topic, say what it is, what problem it answers, and how it connects to the other parts. Do not derive any part. The reasoning that makes each part follow, including the step-by-step argument, the proof, and the worked derivation, belongs to the lesson. Treat parts the learner's lesson has not yet reached the same way: say what each part is and why it matters, show how it connects to the others, but leave the derivation to the lesson.
- **Start with the motivation.** Open with why the topic exists, the problem or question that motivates it. Then give the big picture, and then turn to the parts.
- **Use diagrams.** Use mermaid diagrams wherever structure or flow is the point. A diagram of the map itself, showing how the parts depend on or feed into each other, is usually worth including. A table is often the clearest way to compare parts side by side.
- **Be concrete.** Ground each part in a small, specific example of what it looks like, not just a description of it.
- Length: typically 1200 to 2500 words across all sections.

### Shape

- `body` is a short intro of two to four sentences: what the topic is for and what this overview covers.
- The article goes in `sections`, in reading order, typically four to eight sections. Each has a `heading`, a markdown `body`, and `planNodeIds`.
- `planNodeIds`: when you are given the lesson plan's nodes, with an id and title, tag each section with the ids of the nodes that teach the part it describes. Use exact ids from that list only. A section that maps to no node, such as the motivation or the big picture, gets none. With no plan, leave every `planNodeIds` empty.
- Do not repeat the section headings inside the section bodies.
