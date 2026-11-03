"use client";

import { Button } from "@midday/ui/button";
import { Icons } from "@midday/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@midday/ui/sheet";
import { useState } from "react";
import { MainMenu } from "./main-menu";

export function MobileMenu() {
  const [isOpen, setOpen] = useState(false);

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <div>
        <Button
          aria-label="Open navigation"
          variant="outline"
          size="icon"
          onClick={() => setOpen(true)}
          className="rounded-full w-8 h-8 items-center relative flex md:hidden"
        >
          <Icons.Menu size={16} />
        </Button>
      </div>
      <SheetContent side="left" className="border-none rounded-none -ml-4">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">
          Choose an AGSaaS workspace section.
        </SheetDescription>
        <div className="ml-2 mb-8">
          <Icons.LogoSmall />
        </div>

        <div className="-ml-2">
          <MainMenu onSelect={() => setOpen(false)} isExpanded={true} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
