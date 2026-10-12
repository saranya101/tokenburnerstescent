import Image from "next/image";

export function SingaporeSkyline() {
  return <Image
    className="singapore-skyline"
    src="/images/singapore-skyline.png"
    width={2172}
    height={724}
    alt=""
    aria-hidden="true"
    loading="eager"
    unoptimized
  />;
}
