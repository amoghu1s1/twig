# Tidy graph

Lessons and notes add ideas to one shared knowledge graph. When an idea comes in, Twig checks whether the graph already holds the same idea and joins them if so. That check happens once, at that moment, so the graph can drift: two topics touch the same subject without a link, one idea gets stated twice in different words, or one idea bundles separate facts that other topics could have linked to.

**Tidy graph** reads the whole graph in one pass and suggests fixes. Nothing changes until you approve it.

## Running it

Open the Chains view and press the wand in the top bar, then **Find connections**. It uses the **Strong** model slot, so it bills like a lesson turn. It reads up to 600 propositions, newest first, and usually takes under a minute.

Suggestions come in three kinds. Each one has a one-line reason, with **Apply** and **Skip** buttons. **Apply all** and **Skip all** handle the whole list.

| Kind | What applying it does |
| --- | --- |
| **Connections** | Adds a chain whose premises come from different topics. It ends in an idea you already have, or in a new bridge idea that follows from the premises. A bridge idea is filed under the topics it joins, first the one that supplies most of its premises, so it appears in that topic in the Chains view and on the canvas. |
| **Same idea twice** | Merges two ideas. The kept one keeps its name and statement; the other's wording becomes an alias, and every chain through it now runs through the kept one. |
| **Bundled ideas** | Adds each part as its own idea, plus a chain from the parts to the original. Nothing is deleted. |

Run it again after new lessons. Each run replaces the suggestions still waiting; applied and skipped ones are kept as history in `graph/tidy.json` in the data folder.

## Anki

With **Anki sync** on, new ideas from a tidy (split parts and bridge ideas) are carded and sent like any others. Bridge ideas land in the deck of the topic they are filed under. A merged-away idea's cards are deleted from Anki, or on the next sync if Anki is closed.

## Limits

- A suggestion is checked again when you apply it. If the graph has changed so that it no longer fits (one of its ideas was merged or deleted), it is marked skipped with the reason, never half-applied.
- Applying waits while an extraction is running.
- A bridge idea is the model's claim that follows from its premises, not something a lesson said. Read the reason before applying.
