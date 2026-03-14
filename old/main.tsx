import { Html, Body, Container, Heading, Text } from "@react-email/components";
import { render } from "@react-email/render";

function Newsletter({ name }: { name: string }) {
  return (
    <Html>
      <Body>
        <Container>
          <Heading>Hello {name}</Heading>
          <Text>Welcome to our newsletter.</Text>
        </Container>
      </Body>
    </Html>
  );
}

const html = await render(<Newsletter name="Jack" />);
console.log(html);
