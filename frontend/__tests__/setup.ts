import "@testing-library/dom";
import "@testing-library/react";
import "@testing-library/jest-dom";

// next/navigation reads process.env at import time. Browser-mode tests have no node
// globals, so importing anything that reaches useRouter fails with "process is not
// defined" before a single test runs.
globalThis.process ??= { env: {} } as NodeJS.Process;
