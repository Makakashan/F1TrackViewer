"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import CircuitSidebar from "@/components/circuit-sidebar";
import { useAppPref } from "@/components/app-pref-provider";
import type { CircuitLocation } from "@/lib/f1-circuits";

interface MobileMenuProps {
	circuits: CircuitLocation[];
	selectedId: string | null;
	loadingIndex: boolean;
	onSelect: (id: string) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export default function MobileMenu({
	circuits,
	selectedId,
	loadingIndex,
	onSelect,
	open,
	onOpenChange,
}: MobileMenuProps) {
	const { t } = useAppPref();

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="md:hidden px-2 text-muted-foreground hover:text-foreground"
					aria-label="Open circuit list"
				>
					<Menu className="h-5 w-5" />
				</Button>
			</SheetTrigger>
			<SheetContent
				side="left"
				className="w-75 p-0 bg-sidebar"
				onOpenAutoFocus={(event) => event.preventDefault()}
			>
				<SheetHeader className="px-4 pt-4 pb-2">
					<SheetTitle className="text-sm uppercase tracking-wider text-muted-foreground">
						{t.circuits}
					</SheetTitle>
				</SheetHeader>
				<div className="h-[calc(100%-3rem)]">
					<CircuitSidebar
						circuits={circuits}
						selectedId={selectedId}
						loadingIndex={loadingIndex}
						onSelect={onSelect}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
