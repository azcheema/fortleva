import { redirect } from "next/navigation";

/** UI.md rule 8: Home is the home page. */
export default function Root() {
  redirect("/home");
}
