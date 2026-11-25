"use client";

import { createContext, useContext } from "react";

export interface LabBridgeContextValue {
	jumpToCell: (cellId: string) => void;
	askMentor: (promptText: string) => void;
	navigate?: (href: string) => void;
}

export const LabBridgeContext = createContext<LabBridgeContextValue | null>(null);

export function useLabBridge(): LabBridgeContextValue | null {
	return useContext(LabBridgeContext);
}
