package com.example;

import java.util.ArrayList;
import java.util.List;

/**
 * A deliberately minimal in-memory todo CLI.
 *
 * <p>Supported today: {@code add <text>} and {@code list}. Due dates, overdue
 * markers, and a due-today command are intentionally absent so the SDD flow has
 * an observable feature to specify and implement.</p>
 */
public final class TodoCli {

    private final List<String> tasks = new ArrayList<>();

    public void add(String text) {
        tasks.add(text);
    }

    public List<String> list() {
        return List.copyOf(tasks);
    }

    public static void main(String[] args) {
        TodoCli cli = new TodoCli();
        if (args.length == 0) {
            System.out.println("usage: todo <add|list> [args]");
            return;
        }
        switch (args[0]) {
            case "add" -> {
                cli.add(String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length)));
                System.out.println("added");
            }
            case "list" -> cli.list().forEach(System.out::println);
            default -> System.out.println("unknown command: " + args[0]);
        }
    }
}
