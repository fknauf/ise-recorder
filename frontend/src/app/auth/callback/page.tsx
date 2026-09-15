"use client";

import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

export default function AuthCallback() {
  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "row",
        justifyContent: "center",
        marginTop: 16
      })}
    >
      <AuthStatusMessage/>
    </div>
  );
}
