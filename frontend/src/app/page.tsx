"use client";
import { ToastContainer } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { QuotaWarning } from "@/lib/components/QuotaWarning";
import { RecorderControls } from "@/lib/components/RecorderControls";
import { SavedRecordingsSection } from "@/lib/components/SavedRecordingsSection";
import { PreviewSection } from "@/lib/components/PreviewSection";
import { GithubLink } from "@/lib/components/GithubLink";
import { AuthStatusMessage } from "@/lib/components/AuthStatusMessage";
import { useAutoSignin } from "react-oidc-context";
import { useAccessTokenSource } from "@/lib/hooks/useAccessTokenSource";
import { useHydrated } from "@/lib/hooks/useHydrated";

function AutoSignin() {
  useAutoSignin();
  return null;
}

export default function Home() {
  const hydrated = useHydrated();
  const { authRequired } = useAccessTokenSource();

  return (
    <div
      className={style({
        display: "flex",
        flexDirection: "column",
        font: "body",
        gap: 8,
        height: "[100vh]",
        width: "[100vw]"
      })}
    >
      { hydrated && authRequired && <AutoSignin/> }
      <div
        className={style({
          alignItems: "start",
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          gap: 40
        })}
      >
        <RecorderControls/>
        <GithubLink styles={style({ marginTop: 32 })}/>
      </div>

      <div
        className={style({
          display: "flex",
          flexDirection: "row",
          justifyContent: "center",
          marginTop: 16
        })}
      >
        <AuthStatusMessage/>
        <QuotaWarning thresholdBytes={2 ** 30}/>
      </div>
      <PreviewSection canvasWidth={384} canvasHeight={216}/>
      <SavedRecordingsSection/>
      <ToastContainer/>
    </div>
  );
}
