import { memo } from "react";

interface Segment {
  id: number;
  state: "idle" | "downloading" | "finished";
}

interface Props {
  segments: Segment[];
}

export const SegmentVisualizer = memo(function SegmentVisualizer({ segments }: Props) {
  return (
    <div className="flex gap-0.5 h-1.5 w-full bg-background/50 rounded-sm overflow-hidden">
      {segments.map((segment) => (
        <div
          key={segment.id}
          className={`h-full flex-1 transition-colors duration-200 ${
            segment.state === "finished"
              ? "bg-success"
              : segment.state === "downloading"
              ? "bg-accent animate-pulse"
              : "bg-border"
          }`}
        />
      ))}
    </div>
  );
});

SegmentVisualizer.displayName = "SegmentVisualizer";
