import { ReadingPage } from "@/components/readings/library";

export const dynamic = "force-dynamic";

export default async function ReadingDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <ReadingPage id={id} />;
}
