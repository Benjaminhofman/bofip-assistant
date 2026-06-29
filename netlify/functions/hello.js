// Exemple de fonction Netlify (endpoint: /.netlify/functions/hello)
export default async (request, context) => {
  return new Response(
    JSON.stringify({ message: "Bonjour depuis Netlify Functions 👋" }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
};
