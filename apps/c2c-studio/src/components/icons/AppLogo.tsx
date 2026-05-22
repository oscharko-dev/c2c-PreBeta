import React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface AppLogoProps extends React.HTMLAttributes<HTMLDivElement> {
  compact?: boolean;
}

export function AppLogo({
  className,
  compact = false,
  ...props
}: AppLogoProps) {
  const size = compact ? 28 : 32;

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center overflow-hidden",
        compact ? "h-7 w-7" : "h-8 w-8",
        className,
      )}
      aria-hidden="true"
      {...props}
    >
      <Image
        src="/brand/keiko-logo.svg"
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        draggable={false}
        priority
        unoptimized
      />
    </div>
  );
}
