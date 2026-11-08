# Obsidian vault

LearnHarness can write your knowledge graph as an Obsidian vault: a folder of linked Markdown notes you can read, search and browse in Obsidian on your Mac and phone. No model is involved, so it costs nothing.

## What it writes

| File | Contents |
| --- | --- |
| `Home.md` | Every topic, with how many ideas it holds. |
| `Topics/<topic>.md` | One hub per lesson or notes source: its ideas with their statements, its reasoning chains, and **Links to other topics** (chains that pull in ideas from elsewhere). |
| `Ideas/<idea>.md` | One note per proposition: the statement, **Follows from** (the premises of each chain that concludes it), **Leads to** (what it helps derive, and with what), other phrasings, and its topics. |

Links are ordinary `[[wiki links]]`, so backlinks and Obsidian's graph view work straight away. Ideas that share a name get a short id suffix so every link stays exact.

## Where it goes

- If `LH_OBSIDIAN_VAULT` is set, there.
- Otherwise, if Obsidian keeps vaults in iCloud on this Mac (`~/Library/Mobile Documents/iCloud~md~obsidian/Documents` exists), a vault called **LearnHarness** inside it. It then shows up in Obsidian on your iPhone with no extra setup.
- Otherwise `~/Documents/LearnHarness Vault`.

**Settings → Graph → Obsidian vault** shows the folder in use.

To open it on the Mac: Obsidian → **Open folder as vault** → choose that folder. On the iPhone, with an iCloud vault: Obsidian → open the **LearnHarness** vault.

## Keeping it up to date

- **Settings → Graph → Obsidian sync:** when on, the vault is rewritten after each extraction run that adds ideas, each **Re-read**, and each applied tidy. Off by default.
- **Settings → Graph → Obsidian vault → Write now:** writes it once.

Only notes whose text changed are rewritten, so iCloud syncs real edits only.

## Your own notes

The generated notes are overwritten on every write, so edits to them are lost. Add your own notes as new files anywhere in the vault: LearnHarness keeps a list of the files it wrote (`.learnharness/manifest.json`) and never changes or deletes anything else.
