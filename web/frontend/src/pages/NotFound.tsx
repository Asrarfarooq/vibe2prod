import { useEffect } from "react";
import { TopBar, type Crumb } from "../components/TopBar";
import { Link } from "../components/Link";
import s from "./RunPage.module.css";

interface Props {
  title?: string;
  body?: string;
  crumbs?: Crumb[];
  back?: Crumb;
}

export function NotFound({
  title = "This page does not exist",
  body = "Projects live at /projects/<id> and runs at /projects/<id>/runs/<run id>.",
  crumbs,
  back = { label: "Go to projects", to: "/" },
}: Props) {
  useEffect(() => {
    document.title = "Not found · Vibe2Prod";
  }, []);
  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className={s.page}>
        <div className={s.message}>
          <p className={`${s.code} num`}>404</p>
          <h1 className={s.msgTitle}>{title}</h1>
          <p className={s.msgBody}>{body}</p>
          <Link to={back.to} id="notfound-back" className={s.secondaryBtn}>
            {back.label}
          </Link>
        </div>
      </main>
    </>
  );
}
