import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "diwa — Digital Wallet",
    short_name: "diwa",
    description: "A digital wallet for managing accounts, balances, income, and expenses.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#F6F7FB",
    theme_color: "#F6F7FB",
    icons: [
      { src: "/wallet-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
