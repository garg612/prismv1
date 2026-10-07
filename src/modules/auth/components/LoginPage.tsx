import StickyHeader from "./StickyHeader";
import HeroSection from "./HeroSection";
import FeaturesSection from "./FeaturesSection";
import PipelineSection from "./PipelineSection";
import TrustSection from "./TrustSection";
import SignInSection from "./SignInSection";
import Footer from "./Footer";

export default function LoginPage({ authError = null }: { authError?: string | null }) {
    return (
        <div className="flex flex-col min-h-screen">
            <StickyHeader />
            <div className="flex-1">
                <HeroSection />
                <FeaturesSection />
                <PipelineSection />
                <TrustSection />
                <SignInSection authError={authError} />
            </div>
            <Footer />
        </div>
    );
}
