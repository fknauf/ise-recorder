"use client";
import { Content, Heading, InlineAlert } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useEffect } from "react";

export default function ErrorPage({
  error
}: Readonly<{
  error: Error & { digest?: string }
}>) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "row",
        justifyContent: "center",
        marginTop: 16
      })}
    >
      <InlineAlert variant="negative">
        <Heading>Unexpected Error</Heading>
        <Content>
          {error.message}
        </Content>
      </InlineAlert>
    </div>
  );
}
