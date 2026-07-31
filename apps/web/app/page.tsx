import { Nav } from '@/components/landing/Nav';
import { Hero } from '@/components/landing/Hero';
import { RealConversions } from '@/components/landing/RealConversions';
import { PainPoints } from '@/components/landing/PainPoints';
import { Differentiators } from '@/components/landing/Differentiators';
import { Suitability } from '@/components/landing/Suitability';
import { Pricing } from '@/components/landing/Pricing';
import { Faq } from '@/components/landing/Faq';
import { Footer } from '@/components/landing/Footer';

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <RealConversions />
        <PainPoints />
        <Differentiators />
        <Suitability />
        <Pricing />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
