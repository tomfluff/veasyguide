// The Mantine theme, from DESIGN.md.
//
// Without this, every Mantine control (sliders, buttons, switches) renders in the framework's
// default blue — a colour that appears nowhere else in the product. Setting it here rather
// than overriding controls one at a time in CSS, which is how you end up with three different
// blues and one purple.
import { createTheme, type MantineColorsTuple } from "@mantine/core";

// DESIGN.md's brand scale. Index 6 is what Mantine uses as the default filled shade.
const brand: MantineColorsTuple = [
  "#f7ecfe",
  "#ecd6fb",
  "#d9abf7",
  "#c67df3",
  "#b657ef",
  "#ac40ee",
  "#d27cf7", // 6 — the brand
  "#9330d4",
  "#7b2cbf", // 8 — the light-theme shade; #d27cf7 is ~2:1 on white and fails contrast
  "#4c1d95",
];

export const theme = createTheme({
  primaryColor: "brand",
  colors: { brand },
  // Atkinson Hyperlegible, or every Mantine control falls back to the framework's default stack.
  // Faces self-hosted via @fontsource (main.tsx); matches --font in index.css.
  fontFamily: '"Atkinson Hyperlegible", sans-serif',
  // The app is used by people who cannot see it well. Nothing in it renders below 16px.
  fontSizes: { xs: "0.875rem", sm: "0.9375rem", md: "1rem", lg: "1.125rem", xl: "1.25rem" },
});
