import demo01Raw from '../../fixtures/demo-01.json?raw';
import demo02Raw from '../../fixtures/demo-02.json?raw';
import adversarialRaw from '../../fixtures/adversarial/smuggled-address.json?raw';
import type { IntakeMessageInput, MockFixture } from '../core/index.ts';

export interface DemoFixture extends MockFixture { readonly messages: readonly IntakeMessageInput[]; }
// Trusted bundled fixture files only. User imports always go through importMatterJson instead.
export const DEMOS: Readonly<Record<string, DemoFixture>> = {
  'demo-01': JSON.parse(demo01Raw) as DemoFixture,
  'demo-02': JSON.parse(demo02Raw) as DemoFixture,
};
export const SMUGGLED_ADDRESS = JSON.parse(adversarialRaw) as DemoFixture;
