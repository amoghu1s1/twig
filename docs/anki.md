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

Decks are named `LearnHarness::<source>` after the proposition's birth source. Every card is tagged `learnharness`, `lh::<proposition id>`, and `lh-card::<kind>`.

## When Anki is closed

Cards are saved before they are sent, in `anki/cards.json` in the data folder. If Anki can't be reached, they wait there and go out with the next send or automatic sync. Before adding a proposition's cards, LearnHarness searches Anki for its `lh::<id>` tag, so nothing is added twice, even if `cards.json` is lost.

Without AnkiConnect, **Settings → Graph → Anki → Import file** downloads every carded proposition as a text file for Anki's **File → Import**. Its header sets the note type, deck, and tag columns.

## Limits

- Cards are made from the graph's propositions and reasoning chains, not from your answers in sessions.
- Editing or deleting a proposition later does not change cards already in Anki.
- Cards for practice sessions are not made, because practice writes nothing to the graph.
