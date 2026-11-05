// config/studios.js

const RAACK_STUDIOS = [
  "Kilpauk", "Mylapore", "Velachery", "Cuddalore", "Tambaram", "Mogappair",
  "Thoraipakkam", "Avadi", "Keelkattalai", "Mugalivakkam", "Sholinganallur",
  "Neelankarai", "Kolathur", "Pallikaranai", "Old Perungalathur", "Guduvancheri",
  "Puducherry", "Ramapuram", "Saidapet", "Old pallavaram", "Mannivakkam",
  "Chidambaram", "Hasthinapuram", "Thiruverkadu", "Surapet", "Maraimalai Nagar",
  "Padur", "Medavakkam", "Ambattur", "Arumbakkam", "Ayappakkam", "Sithalapakkam",
  "Perumbakkam", "Basavanagudi", "Pudupakkam", "Urapakkam", "Thanjavur",
  "Pammal", "Kumbakonam", "Maduravoyal", "Kandigai", "Kundrathur",
  "Madambakkam", "Navalur", "Kelambakkam", "Iyyappanthangal", "Mappedu",
  "Vyasarpadi", "Kolapakkam", "Padappai", "Polachery", "Kattur"
];

/**
 * Normalizes branch names extracted by AI against the master Raack Studios list.
 */
function findMatchingStudio(rawBranchText) {
  if (!rawBranchText || rawBranchText === "N/A") return "Unknown Branch";

  const cleanInput = rawBranchText.toLowerCase().trim();
  
  // Exact match first, then full-word/substring check
  const exactMatch = RAACK_STUDIOS.find(s => s.toLowerCase() === cleanInput);
  if (exactMatch) return `Raack ${exactMatch}`;

  const partialMatch = RAACK_STUDIOS.find(studio => {
    const sLower = studio.toLowerCase();
    return cleanInput.includes(sLower);
  });

  return partialMatch ? `Raack ${partialMatch}` : rawBranchText;
}

module.exports = { RAACK_STUDIOS, findMatchingStudio };