// Starter master data for a new Nebula workspace. Programmes and the one
// facility come from the PRD; the item list is a starter set of common
// essential medicines and consumables for Administrators to edit.
import type { Facility, Item } from "../domain/types";

type ItemSeed = Partial<Item> & { name: string; code: string; baseUnit: string };

const I = (n: number, name: string, strength: string | undefined, form: string, packSize: string, baseUnit: string, genericName?: string): ItemSeed => ({
  code: `EML-${String(n).padStart(3, "0")}`,
  name,
  genericName,
  strength,
  form,
  packSize,
  baseUnit,
});

export const STARTER: {
  programmes: string[];
  facilities: Array<Partial<Facility> & { name: string }>;
  items: ItemSeed[];
} = {
  programmes: ["DRF", "Essential Medicine", "Family Planning", "MNCH", "Nutrition", "IMPACT", "Abba-Care", "Free-MNCH"],
  facilities: [{ name: "Government House Clinic" }],
  items: [
    I(1, "Amoxicillin", "500mg", "capsule", "100 capsules", "capsule"),
    I(2, "Amoxicillin", "250mg", "capsule", "100 capsules", "capsule"),
    I(3, "Amoxicillin dispersible", "250mg", "tablet", "100 tablets", "tablet"),
    I(4, "Amoxicillin suspension", "125mg/5ml", "suspension", "100ml bottle", "bottle"),
    I(5, "Paracetamol", "500mg", "tablet", "1000 tablets", "tablet"),
    I(6, "Paracetamol syrup", "120mg/5ml", "syrup", "60ml bottle", "bottle"),
    I(7, "Artemether/Lumefantrine", "20/120mg", "tablet", "24 tablets", "tablet", "Artemether + Lumefantrine"),
    I(8, "Artesunate injection", "60mg", "vial", "1 vial", "vial"),
    I(9, "Sulfadoxine/Pyrimethamine", "500/25mg", "tablet", "3 tablets", "tablet", "SP"),
    I(10, "Malaria rapid diagnostic test", undefined, "kit", "25 tests", "piece", "mRDT"),
    I(11, "Oral rehydration salts", "20.5g", "sachet", "100 sachets", "sachet", "ORS"),
    I(12, "Zinc sulphate dispersible", "20mg", "tablet", "100 tablets", "tablet"),
    I(13, "Ferrous sulphate", "200mg", "tablet", "1000 tablets", "tablet"),
    I(14, "Folic acid", "5mg", "tablet", "1000 tablets", "tablet"),
    I(15, "Metronidazole", "200mg", "tablet", "1000 tablets", "tablet"),
    I(16, "Ciprofloxacin", "500mg", "tablet", "100 tablets", "tablet"),
    I(17, "Cotrimoxazole", "480mg", "tablet", "1000 tablets", "tablet", "Sulfamethoxazole + Trimethoprim"),
    I(18, "Ceftriaxone injection", "1g", "vial", "1 vial", "vial"),
    I(19, "Gentamicin injection", "80mg/2ml", "ampoule", "10 ampoules", "ampoule"),
    I(20, "Oxytocin injection", "10IU/ml", "ampoule", "10 ampoules", "ampoule"),
    I(21, "Misoprostol", "200mcg", "tablet", "3 tablets", "tablet"),
    I(22, "Magnesium sulphate injection", "50%", "ampoule", "10 ampoules", "ampoule"),
    I(23, "Chlorhexidine gel", "7.1%", "tube", "10g tube", "tube"),
    I(24, "Medroxyprogesterone acetate injection", "150mg/ml", "vial", "1 vial", "vial", "DMPA-IM"),
    I(25, "Levonorgestrel/Ethinylestradiol", "0.15/0.03mg", "tablet", "1 cycle", "cycle", "Combined oral contraceptive"),
    I(26, "Male condom", undefined, "piece", "144 pieces", "piece"),
    I(27, "Levonorgestrel implant", "75mg", "implant", "1 set", "piece"),
    I(28, "Ready-to-use therapeutic food", "92g", "sachet", "150 sachets", "sachet", "RUTF"),
    I(29, "Vitamin A capsule", "200,000IU", "capsule", "500 capsules", "capsule"),
    I(30, "Albendazole", "400mg", "tablet", "100 tablets", "tablet"),
    I(31, "Ibuprofen", "400mg", "tablet", "100 tablets", "tablet"),
    I(32, "Amlodipine", "5mg", "tablet", "100 tablets", "tablet"),
    I(33, "Metformin", "500mg", "tablet", "100 tablets", "tablet"),
    I(34, "Hydrochlorothiazide", "25mg", "tablet", "100 tablets", "tablet"),
    I(35, "Sodium chloride infusion", "0.9%", "bottle", "500ml bottle", "bottle", "Normal saline"),
    I(36, "Dextrose infusion", "5%", "bottle", "500ml bottle", "bottle"),
    I(37, "Ringer's lactate infusion", undefined, "bottle", "500ml bottle", "bottle"),
    I(38, "Disposable syringe with needle", "5ml", "piece", "100 pieces", "piece"),
    I(39, "Examination gloves", "medium", "piece", "100 pieces", "piece"),
    I(40, "IV cannula", "22G", "piece", "50 pieces", "piece"),
    I(41, "Absorbent cotton wool", "500g", "roll", "1 roll", "roll"),
    I(42, "Adhesive plaster", "7.5cm x 5m", "roll", "1 roll", "roll"),
  ],
};
