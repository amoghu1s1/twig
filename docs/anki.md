# Anki flashcards

LearnHarness can turn the propositions in your knowledge graph into Anki flashcards, so you can keep exercising what you learned between sessions, including on your phone through Anki's own sync.

## Set up

1. Install [Anki](https://apps.ankiweb.net) and the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on (code `2055492159`) on the machine running LearnHarness. Restart Anki.
2. Keep Anki open while sending. AnkiConnect listens on `http://127.0.0.1:8765`; set `LH_ANKICONNECT_URL` to use another address.
3. Make sure the **Cheap** model slot is set. The card writer runs there, like graph extraction, and bills the same way.
4. To review on the go, sign in to AnkiWeb in Anki and use AnkiMobile or AnkiDroid. Anki syncs the new cards itself.

## Sending cards

- **Chains view:** select sources or folders and press **Anki** in the selection bar. Their propositions are carded and sent.
- **Settings → Graph → Anki → Send all:** cards every proposition in the graph that has no cards yet, then sends everything waiting.
- **Settings → Graph → Anki sync:** when on, the propositions each extraction run adds are carded and sent automatically. Off by default, because carding costs model money.

Each proposition is carded once. Its 2 to 4 cards follow the practice doctrine: a fresh situation that needs the idea (recall), the grounds of a conclusion (why), a chain run forward (compose), and the separating feature against a confusable (discriminate). Fronts never name the idea they exercise.

## Card formats

The card writer picks a format per card, to suit the content:

| Format | Anki note type | Used for |
| --- | --- | --- |
| Cloze | LearnHarness Cloze | a fact sentence with its key term, name, date or number hidden |
| Type-in | LearnHarness Type-in | a one to three word answer you type, checked letter by letter |
| Reversed | LearnHarness Reversed | a true two-way pair, asked in both directions |
| Basic | LearnHarness Basic | why, how and situation questions |

Cards are short by rule: a front of at most about 25 words, an answer of at most about 10, and an optional one-line **extra** shown after the answer (the reason or a hook). The writer is sent back to shorten anything much longer. The decisive word is bold, and `$…$` math renders with MathJax.

LearnHarness creates the four note types in Anki on first send, with their own card styling (a small topic and card-kind label, a large centred question, light and night mode). Each later send refreshes their styling and templates, so changes here reach existing cards. The proposition's name appears small under every answer.

Decks are named `LearnHarness::<source>` after the proposition's birth source. Every card is tagged `learnharness`, `lh::<proposition id>`, `lh-card::<kind>` and `lh-format::<format>`.

## Rebuilding cards

**Settings → Graph → Anki → Rebuild** deletes the LearnHarness cards in Anki, including their review history, and writes and sends fresh ones. Use it after the card writer improves. It needs Anki open, and refuses rather than forget cards Anki still holds.

## When Anki is closed

Cards are saved before they are sent, in `anki/cards.json` in the data folder. If Anki can't be reached, they wait there and go out with the next send or automatic sync. Before adding a proposition's cards, LearnHarness searches Anki for its `lh::<id>` tag, so nothing is added twice, even if `cards.json` is lost.

Without AnkiConnect, **Settings → Graph → Anki → Import file** downloads every carded proposition as a text file for Anki's **File → Import**. Its header sets the note type, deck, and tag columns. An import file cannot create note types, so its cards use Anki's built-in Basic, Cloze, Basic (type in the answer) and Basic (and reversed card), without the LearnHarness styling.

## Limits

- Cards are made from the graph's propositions and reasoning chains, not from your answers in sessions.
- Editing or deleting a proposition later does not change cards already in Anki.
- Cards for practice sessions are not made, because practice writes nothing to the graph.
- Cards carry no images yet: propositions are text, and the graph keeps no pictures to attach.
