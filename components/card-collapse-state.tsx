"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

export const CARD_COLLAPSE_STORAGE_PREFIX = "lh:card-collapse:";

function readStoredOverrides(chatId: string): Map<string, boolean> {
	const map = new Map<string, boolean>();
	if (typeof window === "undefined") return map;
	try {
		const raw = window.localStorage?.getItem(`${CARD_COLLAPSE_STORAGE_PREFIX}${chatId}`);
		if (!raw) return map;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
		for (const [k, v] of Object.entries(parsed)) {
			if (typeof v === "boolean") map.set(k, v);
		}
	} catch {
		// Corrupt or unavailable storage: fall back to defaults.
	}
	return map;
}

function writeStoredOverrides(chatId: string, overrides: ReadonlyMap<string, boolean>): void {
	if (typeof window === "undefined") return;
	try {
		const key = `${CARD_COLLAPSE_STORAGE_PREFIX}${chatId}`;
		if (overrides.size === 0) {
			window.localStorage?.removeItem(key);
		} else {
			window.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(overrides)));
		}
	} catch {
		// Storage quota or unavailable: keep in-memory state.
	}
}

/** Per-session collapse state for answered question / check / prediction / code
 *  cards. Older cards default collapsed so long sessions stay tidy and note-like;
 *  the most recent answered card defaults expanded. Manual toggles persist per
 *  chat in localStorage. Per-card subscriptions ensure toggling one card never
 *  re-renders unrelated transcript blocks. */
export class CardCollapseStore {
	private overrides: Map<string, boolean>;
	private latestCardId: string | null = null;
	private cardListeners = new Map<string, Set<() => void>>();
	private listeners = new Set<() => void>();

	constructor(readonly chatId: string) {
		this.overrides = readStoredOverrides(chatId);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	subscribeCard = (cardId: string, listener: () => void): (() => void) => {
		let set = this.cardListeners.get(cardId);
		if (!set) {
			set = new Set();
			this.cardListeners.set(cardId, set);
		}
		set.add(listener);
		return () => {
			const cur = this.cardListeners.get(cardId);
			if (!cur) return;
			cur.delete(listener);
			if (cur.size === 0) this.cardListeners.delete(cardId);
		};
	};

	private notifyCard(cardId: string): void {
		const set = this.cardListeners.get(cardId);
		if (set) for (const l of [...set]) l();
		for (const l of [...this.listeners]) l();
	}

	setLatestCardId(id: string | null): void {
		if (this.latestCardId === id) return;
		const prev = this.latestCardId;
		this.latestCardId = id;
		if (prev && !this.overrides.has(prev)) this.notifyCard(prev);
		if (id && !this.overrides.has(id)) this.notifyCard(id);
	}

	isOpen = (cardId: string): boolean => {
		const override = this.overrides.get(cardId);
		if (override !== undefined) return override;
		return cardId === this.latestCardId;
	};

	setOpen(cardId: string, open: boolean): void {
		const current = this.isOpen(cardId);
		if (this.overrides.get(cardId) === open && current === open) return;
		this.overrides.set(cardId, open);
		writeStoredOverrides(this.chatId, this.overrides);
		this.notifyCard(cardId);
	}

	toggle(cardId: string): void {
		this.setOpen(cardId, !this.isOpen(cardId));
	}
}

const CardCollapseContext = createContext<CardCollapseStore | null>(null);

export function CardCollapseProvider({ store, children }: { store: CardCollapseStore; children: ReactNode }) {
	const value = useMemo(() => store, [store]);
	return <CardCollapseContext.Provider value={value}>{children}</CardCollapseContext.Provider>;
}

export function useCardCollapseStore(): CardCollapseStore | null {
	return useContext(CardCollapseContext);
}

const NO_SUBSCRIBE = () => () => {};
const ALWAYS_TRUE = () => true;

export function useCardOpen(cardId: string | undefined, fallbackOpen = true): {
	open: boolean;
	store: CardCollapseStore | null;
} {
	const store = useCardCollapseStore();
	const subscribe = useCallback(
		(listener: () => void) => (store && cardId ? store.subscribeCard(cardId, listener) : NO_SUBSCRIBE()),
		[store, cardId],
	);
	const getSnapshot = useCallback(
		() => (store && cardId ? store.isOpen(cardId) : fallbackOpen),
		[store, cardId, fallbackOpen],
	);
	const open = useSyncExternalStore(
		subscribe,
		store && cardId ? getSnapshot : ALWAYS_TRUE,
		store && cardId ? getSnapshot : ALWAYS_TRUE,
	);
	return { open: store && cardId ? open : fallbackOpen, store };
}
