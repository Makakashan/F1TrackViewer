import { Suspense } from "react";
import HomeRouter from "@/components/home-router";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeRouter />
    </Suspense>
  );
}
