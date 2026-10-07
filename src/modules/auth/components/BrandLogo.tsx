import Image from "next/image";
import horizontalBlack from "../../../../logos/kit/final-horizontal-black.svg";
import horizontalWhite from "../../../../logos/kit/final-horizontal-white.svg";

/** PRism horizontal logo from the brand kit in /logos/kit: black on light, white on dark. */
export default function BrandLogo({ className = "h-7 w-auto", priority = false }: { className?: string; priority?: boolean }) {
    return (
        <>
            <Image src={horizontalBlack} alt="PRism" priority={priority} className={`${className} dark:hidden`} />
            <Image src={horizontalWhite} alt="PRism" priority={priority} className={`${className} hidden dark:block`} />
        </>
    );
}
